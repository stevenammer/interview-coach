import { Repository, hash } from '../../src/repository.js';
import { productionSql } from '../../src/db.js';
import { GeminiAdapter, providerFor } from '../../src/model.js';
import { CoachService, InputError, SKIP_ANSWER } from '../../src/service.js';
import { GuestRepository } from '../../src/guest.js';
import { passwordHash, verifyPassword, validUsername, issueSession, sessionToken, abuseSubject, accountAbuseSubject } from '../../src/auth.js';
import { getStore } from '@netlify/blobs';
import { startVoice, voiceConfigured, startGuestVoice, guestVoiceStatus, guestVoiceConfigured, guestVoiceLimits } from '../../src/voice.js';
import { translatePlain, cachedPlain, PLAIN_KINDS, PLAIN_MAX_INPUT } from '../../src/plain.js';

// "Say it plain" has its own small allowance, separate from practice, so turning on
// Plain English can never use up the calls someone needs to practice. Cache hits are free.
const PLAIN_PER_HOUR = 120;
const PLAIN_PER_DAY = 1500;
const PENDING_UPLOAD_MAX_BYTES = 20_000_000;
// Match uploadOriginal in the browser. Fixed part sizes bind blob storage to the
// declared reservation even when chunks arrive concurrently or are replayed.
const UPLOAD_CHUNK_BYTES = 1_400_000;
const boundedCoachNote = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 500;

const GUEST_FREE_OPS = new Set(['ledger', 'requirements', 'workspaces', 'drills', 'history', 'real_feed',
  'fact_conflicts', 'report_fact_conflict', 'update_fact_conflict',
  'review', 'review_many', 'delete_fact', 'delete_source', 'delete_writing_sample', 'interview_date',
  'workspace_settings', 'writing_profile', 'writing_sample', 'immerse_get', 'job_status',
  'fact_gate_decision', 'resolve_stronger_slot', 'source_uploads', 'drill_call', 'job_hunt_update', 'job_hunt_history', 'job_hunt_log', 'job_hunt_log_delete'])

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
}

function errorResponse(error) {
  const status = error.status ?? (error.code === 'spend_cap_reached' ? 503 :
    error.code === 'model_unavailable' || error.code === 'accounting_unavailable' ||
    error.code === 'invalid_model_output' ? 503 : 500);
  return json({ error: error.code ?? 'server_error', message: status === 500 ? 'Server error' : error.message,
    retryable: status === 503 }, status);
}

export function createHandler({ repo, model, env = process.env, platformIp = null,
  blobStore = null, fetchImpl = fetch, plainModel = null, plainCache = null }) {
  return async function handler(request) {
    try {
      const url = new URL(request.url);
      const op = url.searchParams.get('op');
      const origin = request.headers.get('origin');
      if (request.method === 'POST') {
        const allowedOrigins = env.ALLOWED_ORIGINS?.split(',').map((value) => value.trim()).filter(Boolean);
        if (!origin || !(allowedOrigins?.length ? allowedOrigins.includes(origin) : origin === url.origin) || request.headers.get('x-coach-csrf') !== '1' ||
          !request.headers.get('content-type')?.startsWith('application/json')) {
          return json({ error: 'same_origin_required' }, 403);
        }
      }
      const data = request.method === 'POST' ? await request.json() : {};
      if (JSON.stringify(data).length > (op === 'upload_chunk' ? 2100000 :
        op === 'transcribe_voice' ? 3100000 : op === 'read_image' ? 2900000 : 110000)) return json({ error: 'request_too_large' }, 413);
      const secure = url.protocol === 'https:';
      const abuseKey = env.ABUSE_HMAC_KEY;
      if (!abuseKey || abuseKey.length < 24) return json({ error: 'abuse_limits_unavailable' }, 503);
      const subject = abuseSubject(request, abuseKey, platformIp);

      if (op === 'signup' || op === 'login') {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
        if (!await repo.abuse(op, subject, 12)) return json({ error: 'rate_limited' }, 429);
        const { username, password } = data;
        if (!validUsername(username) || typeof password !== 'string' ||
          password.length < 12 || password.length > 200) {
          throw new InputError('Enter a valid username and a password of 12 to 200 characters.');
        }
        if (op === 'login' && !await repo.abuse('login_account', accountAbuseSubject(username, abuseKey), 8, 15)) {
          return json({ error: 'rate_limited' }, 429);
        }
        let user;
        if (op === 'signup') {
          if (await repo.userByName(username)) throw new InputError('Username is unavailable.');
          user = await repo.createUser(username, await passwordHash(password));
        } else {
          const found = await repo.userByName(username);
          if (!found || !await verifyPassword(password, found.password_hash)) {
            return json({ error: 'invalid_credentials' }, 401);
          }
          user = { id: found.id, username: found.username };
        }
        const issued = await issueSession(repo, user, secure);
        return json({ user: issued.user }, 200, { 'set-cookie': issued.cookie });
      }

      const token = sessionToken(request);
      const user = token ? await repo.session(hash(token)) : null;
      if (op === 'session') return json({ user, voiceAvailable: Boolean(user ? voiceConfigured(env) : guestVoiceConfigured(env)),
        guestVoiceLimits: guestVoiceLimits(env) });
      if (op === 'logout') {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
        if (token) await repo.revoke(hash(token));
        return json({ ok: true }, 200, { 'set-cookie': `${secure ? '__Host-ic_session' : 'ic_session'}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}` });
      }

      if (op === 'change_password' && request.method === 'POST') {
        if (!user) return json({ error: 'authentication_required' }, 401);
        if (!await repo.abuse('change_password', subject, 6)) return json({ error: 'rate_limited' }, 429);
        const { currentPassword, newPassword } = data;
        const found = await repo.userByName(user.username);
        if (typeof currentPassword !== 'string' || !found || !await verifyPassword(currentPassword, found.password_hash)) {
          return json({ error: 'invalid_credentials' }, 401);
        }
        await repo.setPasswordHash(user.id, await passwordHash(newPassword), hash(token));
        return json({ changed: true });
      }

      if (op === 'logout_everywhere' && request.method === 'POST') {
        if (!user) return json({ error: 'authentication_required' }, 401);
        await repo.revokeAllSessions(user.id, hash(token));
        return json({ ok: true });
      }

      if (op === 'delete_account' && request.method === 'POST') {
        if (!user) return json({ error: 'authentication_required' }, 401);
        if (blobStore) for (const upload of await repo.allUploads(user.id)) {
          for (let part = 0; part < upload.chunk_count; part += 1) {
            await blobStore.delete(`${user.id}/${upload.id}/${part}`);
          }
        }
        await repo.deleteAccount(user.id);
        return json({ deleted: true }, 200, { 'set-cookie': `${secure ? '__Host-ic_session' : 'ic_session'}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}` });
      }

      const guest = data.guest === true;
      if (!user && !guest) return json({ error: 'authentication_required' }, 401);
      if (guest && user) return json({ error: 'choose_account_or_guest' }, 400);
      if (op === 'plain') {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
        const { text, kind } = data;
        if (!PLAIN_KINDS.includes(kind) || typeof text !== 'string' || !text.trim()) {
          throw new InputError('Choose a piece of text to put in plain words.');
        }
        if (text.length > PLAIN_MAX_INPUT) {
          return json({ result: await translatePlain({ text, kind, model: null, allowModel: false }) });
        }
        // Plain English never carries or returns guest state. Personal notes never enter
        // the shared cache, where another account could receive note-shaped wording.
        const instructions = user ? await new CoachService(repo, model, user.id)
          .standingInstructions(user.id, data.workspaceId ?? null) : '';
        const safeCache = instructions && !instructions.endsWith('None.') ? null : plainCache;
        const hit = await cachedPlain(safeCache, text, kind, abuseKey);
        if (hit) return json({ result: hit });
        // Its own small allowance: per person per hour, and one shared daily ceiling.
        const allowed = await repo.abuse('plain', subject, PLAIN_PER_HOUR, 60) &&
          await repo.abuse('plain_all', 'all', PLAIN_PER_DAY, 1440);
        return json({ result: await translatePlain({ text, kind, model: plainModel,
          cache: safeCache, secret: abuseKey, allowModel: allowed, standingInstructions: instructions, owner: user?.id ?? null }) });
      }
      // Reads, confirms, and deletes cost nothing; only model calls get the tight guest limit.
      // The daily spend cap still bounds real cost either way.
      if (guest) {
        const costly = !GUEST_FREE_OPS.has(op);
        const allowed = costly ? await repo.abuse('guest_model', subject, 60, 60) : await repo.abuse('guest', subject, 400, 60);
        if (!allowed) return json({ error: 'rate_limited', message: costly ?
          'That\'s a lot of practice for one hour. Take a breather and try again in a bit, or sign up to keep going.' :
          'Too many taps in a short time. Wait a minute and try again.' }, 429);
      }
      const guestState = data.state ?? {};
      if (guest && (typeof guestState !== 'object' || Array.isArray(guestState))) throw new InputError('Invalid guest state.');
      const profileRepo = guest ? new GuestRepository(guestState) : repo;
      const owner = user?.id ?? 'guest';
      const service = new CoachService(profileRepo, model, user?.id ?? null);
      let result;
      if (op === 'job_status' && request.method === 'POST' && user) {
        const job = await repo.job(owner, data.jobId);
        if (!job) throw new InputError('Job not found', 404);
        result = job;
      } else if (op === 'retry_job' && request.method === 'POST' && user) {
        result = await repo.retryJob(owner, data.jobId);
        if (!result) throw new InputError('This job cannot be retried.', 400);
      } else if (op === 'paste' && request.method === 'POST') {
        if (guest && (data.resume?.length > 8000 || data.jd?.length > 8000)) {
          throw new InputError('As a guest you can paste up to 8,000 characters each. Trim the oldest jobs or the boilerplate at the end of the posting.');
        }
        result = guest ? await service.paste(owner, data) :
          { job: await repo.createJob(owner, 'paste', { resume: data.resume, jd: data.jd, jobLabel: data.jobLabel,
            resumeOffsets: data.resumeOffsets, jdOffsets: data.jdOffsets,
            resumeSection: data.resumeSection, jdSection: data.jdSection }) };
      }
      else if (op === 'flag_debrief' && request.method === 'POST') {
        if (guest) throw new InputError('Sign in to save coaching notes for future practice.', 401);
        result = await service.flagDebrief(owner, { interviewId: data.interviewId, note: data.note });
      }
      else if (op === 'coach_notes' && request.method === 'POST') {
        if (guest) throw new InputError('Sign in to use coach notes.', 401);
        result = await repo.coachNotes(owner, data.workspaceId ?? null);
      }
      else if (op === 'coach_note_update' && request.method === 'POST') {
        if (guest || !data.id || (data.text !== undefined && !boundedCoachNote(data.text)) ||
          (data.active !== undefined && typeof data.active !== 'boolean')) throw new InputError('Enter a coach note under 500 characters.');
        result = await service.updateCoachNote(owner, data.id, { text: data.text, active: data.active });
      }
      else if (op === 'coach_note_delete' && request.method === 'POST') {
        if (guest) throw new InputError('Sign in to use coach notes.', 401);
        if (!await repo.deleteCoachNote(owner, data.id)) throw new InputError('Coach note not found', 404);
        result = { deleted: true };
      }
      else if (op === 'ingest' && request.method === 'POST') {
        if (guest && data.text?.length > 8000) throw new InputError('As a guest you can paste up to 8,000 characters at a time.');
        result = guest ? await service.ingest(owner, data) :
          { job: await repo.createJob(owner, 'ingest', {
            kind: data.kind, title: data.title, text: data.text,
            workspaceId: data.workspaceId, pageOffsets: data.pageOffsets, sectionLabel: data.sectionLabel,
          }) };
      }
      else if (op === 'writing_sample' && request.method === 'POST') result = await service.writingSample(owner, data.title, data.text);
      else if (op === 'workspaces' && request.method === 'POST') result = await profileRepo.workspaces(owner);
      else if (op === 'workspace_progress' && request.method === 'POST') {
        if (guest) result = { pending_facts: 0, has_prep_pack: false, has_practice: false, has_debrief: false };
        else {
          if (!await repo.workspace(owner, data.workspaceId)) throw new InputError('Workspace not found', 404);
          result = await repo.workspaceProgress(owner, data.workspaceId);
        }
      }
      else if (op === 'workspace_settings' && request.method === 'POST') {
        const allowed = ['remote', 'hybrid', 'onsite', 'flexible', 'unspecified'];
        if (!allowed.includes(data.remotePreference) || !allowed.includes(data.listingWorkMode)) {
          throw new InputError('Choose a work preference and listing mode.');
        }
        const hasComparisonFields = data.payDetails !== undefined || data.benefitsDetails !== undefined || data.learnedDetails !== undefined;
        if (hasComparisonFields) {
          const fields = [data.payDetails, data.benefitsDetails, data.learnedDetails];
          if (fields.some((value) => typeof value !== 'string' || value.length > 5000)) {
            throw new InputError('Pay, benefits, and learned details must each be under 5,000 characters.');
          }
        }
        result = await profileRepo.setWorkspacePreferences(owner, data.workspaceId,
          data.remotePreference, data.listingWorkMode);
        if (!result) throw new InputError('Workspace not found', 404);
        if (user && data.roleTitle !== undefined && data.companyName !== undefined) {
          if (typeof data.roleTitle !== 'string' || data.roleTitle.length > 160 ||
              typeof data.companyName !== 'string' || data.companyName.length > 160) {
            throw new InputError('Role and company names must be under 160 characters.');
          }
          result = await repo.setVoiceContext(owner, data.workspaceId,
            data.roleTitle.trim(), data.companyName.trim());
        }
        if (hasComparisonFields) {
          result = await profileRepo.setJobComparison(owner, data.workspaceId, {
            payDetails: data.payDetails, benefitsDetails: data.benefitsDetails, learnedDetails: data.learnedDetails,
          });
          if (!result) throw new InputError('Workspace not found', 404);
        }
      }
      else if (op === 'write_document' && request.method === 'POST') {
        if (guest) result = await service.writeDocument(owner, data.workspaceId, data.kind, data.lane ?? null);
        else {
          if (!['resume', 'cover_letter'].includes(data.kind)) throw new InputError('Choose a résumé or a cover letter.');
          const confirmed = (await repo.facts(owner, data.workspaceId)).filter((fact) =>
            fact.domain === 'candidate' && fact.review_state === 'accepted' && fact.lifecycle === 'active');
          if (confirmed.length < 3) throw new InputError('Confirm at least 3 details in your story bank first. The writer only uses what you have confirmed.');
          if (data.lane !== undefined && data.lane !== null && !['posting', 'training_enablement', 'building_with_ai', 'team_leadership'].includes(data.lane)) {
            throw new InputError('Choose a valid résumé emphasis.');
          }
          result = { job: await repo.createJob(owner, 'write_document', { workspaceId: data.workspaceId, kind: data.kind, lane: data.lane ?? null }) };
        }
      }
      else if (op === 'requirements' && request.method === 'POST') result = await service.requirements(owner, data.workspaceId);
      else if (op === 'immerse_start' && request.method === 'POST') {
        if (!await profileRepo.workspace(owner, data.workspaceId)) throw new InputError('Workspace not found', 404);
        result = guest ? await service.startImmersion(owner, data.workspaceId) :
          { job: await repo.createJob(owner, 'immerse_week', { workspaceId: data.workspaceId }) };
      }
      else if (op === 'immerse_get' && request.method === 'POST') result = await service.immersion(owner, data.workspaceId, data.immersionId);
      else if (op === 'immerse_act' && request.method === 'POST') result = await service.actImmersion(owner,
        data.immersionId, data.choiceId, data.response);
      else if (op === 'dig_start' && request.method === 'POST') result = await service.startDig(owner, data.workspaceId);
      else if (op === 'dig_reflect' && request.method === 'POST') result = await service.reflectDig(owner, data.digId, data.scene);
      else if (op === 'dig_confirm' && request.method === 'POST') result = await service.confirmDig(owner, data.digId, data.scene);
      else if (op === 'interview_date' && request.method === 'POST') result = await service.setInterviewDate(owner, data.workspaceId, data.date);
      else if (op === 'job_hunt_update' && request.method === 'POST') result = await service.updateJobHunt(owner, data.workspaceId, data);
      else if (op === 'job_hunt_history' && request.method === 'POST') {
        if (!await profileRepo.workspace(owner, data.workspaceId)) throw new InputError('Workspace not found', 404);
        result = await profileRepo.jobHuntHistory(owner, data.workspaceId);
      }
      else if (op === 'job_hunt_log' && request.method === 'POST') result = await service.addJobHuntLog(owner, data.workspaceId, data);
      else if (op === 'job_hunt_log_delete' && request.method === 'POST') {
        if (!await profileRepo.deleteJobHuntHistory(owner, data.historyId)) throw new InputError('Job hunt log entry not found', 404);
        result = { deleted: true };
      }
      else if (op === 'drill_build' && request.method === 'POST') result = await service.buildDrills(owner, data.workspaceId,
        { refresh: data.refresh === true });
      else if (op === 'drills' && request.method === 'POST') result = await service.drills(owner, data.workspaceId);
      else if (op === 'prep_pack' && request.method === 'POST') {
        if (guest) throw new InputError('Sign in to save a Prep Pack.', 401);
        result = await service.prepPack(owner, data.workspaceId);
      }
      else if (op === 'prep_section_refresh' && request.method === 'POST') {
        if (guest) throw new InputError('Sign in to refresh a Prep Pack.', 401);
        result = await service.prepPack(owner, data.workspaceId, { refreshKey: data.sectionKey });
      }
      else if (op === 'drill_review' && request.method === 'POST') result = await service.reviewDrill(owner, data.cardId, data.answer);
      else if (op === 'real_capture' && request.method === 'POST') result = await service.captureRealInterview(owner,
        data.workspaceId, data.captureKind, data.text);
      else if (op === 'transcribe_voice' && request.method === 'POST') {
        if (!await profileRepo.workspace(owner, data.workspaceId) ||
          typeof data.base64 !== 'string' || data.base64.length > 2700000 ||
          !['audio/webm', 'audio/mp4', 'audio/ogg'].includes(data.mimeType)) {
          throw new InputError('Choose a short voice note for this workspace.');
        }
        const bytes = Buffer.from(data.base64, 'base64');
        if (!bytes.length || bytes.length > 2000000 || bytes.toString('base64') !== data.base64) {
          throw new InputError('Voice note is invalid or over 2 MB.');
        }
        result = { text: await model.transcribe(data.base64, data.mimeType) };
      }
      else if (op === 'read_image' && request.method === 'POST') {
        if (typeof data.base64 !== 'string' || data.base64.length > 2700000 ||
          !['image/jpeg', 'image/png', 'image/webp'].includes(data.mimeType)) {
          throw new InputError('Choose a screenshot or photo (JPG, PNG, or WebP).');
        }
        const bytes = Buffer.from(data.base64, 'base64');
        if (!bytes.length || bytes.length > 2000000 || bytes.toString('base64') !== data.base64) {
          throw new InputError('That image is invalid or over 2 MB.');
        }
        result = { text: await model.readImage(data.base64, data.mimeType) };
      }
      else if (op === 'real_feed' && request.method === 'POST') result = await service.realInterviewFeed(owner, data.workspaceId);
      else if (op === 'workspace_map' && request.method === 'POST') {
        if (!await profileRepo.workspace(owner, data.workspaceId)) throw new InputError('Workspace not found', 404);
        result = guest ? await service.mapWorkspace(owner, data.workspaceId) :
          { job: await repo.createJob(owner, 'workspace_map', { workspaceId: data.workspaceId }) };
      }
      else if (op === 'writing_profile' && request.method === 'POST') {
        result = data.preferences === undefined ? await profileRepo.writingProfile(owner) :
          await service.setWritingProfile(owner, data.preferences);
      }
      else if (op === 'delete_writing_sample' && request.method === 'POST') {
        const source = await profileRepo.source(owner, data.sourceId);
        if (!source || source.kind !== 'writing_sample') throw new InputError('Writing sample not found', 404);
        await profileRepo.deleteSource(owner, source.id);
        const profile = await profileRepo.writingProfile(owner);
        if (profile.samples.length < 2) await profileRepo.saveWritingProfile(owner, profile.preferences, false);
        result = await profileRepo.writingProfile(owner);
      }
      else if (op === 'upload_init' && request.method === 'POST' && user && blobStore) {
        const expired = await repo.expirePendingUploads(owner);
        for (const upload of expired) for (let part = 0; part < upload.chunk_count; part += 1) {
          await blobStore.delete(`${owner}/${upload.id}/${part}`);
        }
        const source = await repo.source(owner, data.sourceId);
        if (!source) throw new InputError('Source not found', 404);
        if (!['resume', 'jd', 'linkedin', 'background'].includes(source.kind)) {
          throw new InputError('Files can only be attached to document sources.');
        }
        if (typeof data.extractedText !== 'string' || hash(data.extractedText) !== source.content_hash) {
          throw new InputError('The extracted file text does not match this source.');
        }
        if ((await repo.sourceUploads(owner, source.id)).some((upload) => upload.status === 'ready')) {
          throw new InputError('This source already has an original file.');
        }
        if (!Number.isInteger(data.byteSize) || data.byteSize < 1 || data.byteSize > 10000000 ||
          !Number.isInteger(data.chunkCount) || data.chunkCount !== Math.ceil(data.byteSize / UPLOAD_CHUNK_BYTES) ||
          !['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/csv'].includes(data.mimeType) ||
          typeof data.name !== 'string' || data.name.length > 120) throw new InputError('Invalid upload metadata.');
        if (await repo.pendingUploadBytes(owner) + data.byteSize > PENDING_UPLOAD_MAX_BYTES) {
          throw new InputError('Finish or remove a pending upload before adding more files.', 429);
        }
        result = await repo.initUpload(owner, source.id, data.name, data.mimeType, data.byteSize, data.chunkCount);
      }
      else if (op === 'upload_chunk' && request.method === 'POST' && user && blobStore) {
        const upload = await repo.upload(owner, data.uploadId);
        if (!upload || upload.status !== 'pending' || !Number.isInteger(data.part) ||
          data.part < 0 || data.part >= upload.chunk_count || typeof data.base64 !== 'string' ||
          data.base64.length > 2100000) throw new InputError('Invalid upload chunk.');
        const bytes = Buffer.from(data.base64, 'base64');
        const expectedBytes = Math.min(UPLOAD_CHUNK_BYTES, upload.byte_size - data.part * UPLOAD_CHUNK_BYTES);
        if (!bytes.length || bytes.length !== expectedBytes || bytes.toString('base64') !== data.base64) throw new InputError('Invalid upload bytes.');
        await blobStore.set(`${owner}/${upload.id}/${data.part}`, bytes);
        await repo.saveChunk(owner, upload.id, data.part, bytes.length);
        result = { stored: true };
      }
      else if (op === 'upload_finish' && request.method === 'POST' && user && blobStore) {
        if (!await repo.finishUpload(owner, data.uploadId)) throw new InputError('Upload is incomplete.');
        result = { ready: true };
      }
      else if (op === 'source_uploads' && request.method === 'POST' && user && blobStore) {
        if (!await repo.source(owner, data.sourceId)) throw new InputError('Source not found', 404);
        result = (await repo.sourceUploads(owner, data.sourceId)).filter((upload) => upload.status === 'ready')
          .map((upload) => ({ id: upload.id, chunkCount: upload.chunk_count, mimeType: upload.mime_type }));
      }
      else if (op === 'download_chunk' && request.method === 'POST' && user && blobStore) {
        const upload = await repo.upload(owner, data.uploadId);
        if (!upload || upload.status !== 'ready' || !Number.isInteger(data.part) ||
          data.part < 0 || data.part >= upload.chunk_count) throw new InputError('Upload not found', 404);
        const bytes = await blobStore.get(`${owner}/${upload.id}/${data.part}`, { type: 'arrayBuffer' });
        result = { base64: Buffer.from(bytes).toString('base64'), mimeType: upload.mime_type };
      }
      else if (op === 'ledger' && request.method === 'POST') result = await service.ledger(owner, data.workspaceId);
      else if (op === 'fact_conflicts' && request.method === 'POST') result = await service.factConflicts(owner, data.workspaceId);
      else if (op === 'report_fact_conflict' && request.method === 'POST') result = await service.reportFactConflict(owner, data);
      else if (op === 'update_fact_conflict' && request.method === 'POST') result = await service.updateFactConflictReview(owner, data);
      else if (op === 'review' && request.method === 'POST') result = await service.review(owner, data);
      else if (op === 'review_many' && request.method === 'POST') {
        // Confirm or reject several proposals at once (only the caller's own pending facts).
        if (!Array.isArray(data.factIds) || data.factIds.length > 200 || !['confirm', 'reject'].includes(data.action)) {
          throw new InputError('Choose up to 200 facts to confirm or set aside.');
        }
        for (const factId of data.factIds) {
          const fact = await profileRepo.fact(owner, factId);
          if (fact && fact.review_state === 'pending' && fact.lifecycle === 'active') {
            await service.review(owner, { workspaceId: data.workspaceId, factId, action: data.action });
          }
        }
        result = await service.ledger(owner, data.workspaceId);
      }
      else if (op === 'delete_fact' && request.method === 'POST') result = await service.deleteFact(owner, data.workspaceId, data.factId);
      else if (op === 'delete_source' && request.method === 'POST') {
        if (user && blobStore) for (const upload of await repo.sourceUploads(owner, data.sourceId)) {
          for (let part = 0; part < upload.chunk_count; part += 1) {
            await blobStore.delete(`${owner}/${upload.id}/${part}`);
          }
        }
        result = await service.deleteSource(owner, data.workspaceId, data.sourceId);
      }
      else if (op === 'start' && request.method === 'POST') result = await service.start(owner, data.workspaceId, data.persona,
        data.difficulty ?? 2, data.practiceMode ?? 'mock');
      else if (op === 'voice_start' && request.method === 'POST') {
        result = guest ? await startGuestVoice({ repo, env, fetchImpl, plainModel }, service, subject, data) :
          await startVoice({ repo, model, env, fetchImpl, plainModel }, owner, user.username, data);
      }
      else if (op === 'voice_status' && request.method === 'POST' && guest) {
        result = await guestVoiceStatus({ repo, env, fetchImpl }, service, data);
      }
      else if (op === 'voice_status' && request.method === 'POST') {
        const call = await repo.ownerVoiceCall(owner, data.interviewId);
        if (!call) throw new InputError('Voice call not found', 404);
        result = { status: call.status, transcriptReady: call.transcript_revision > 0,
          turns: call.transcript_revision ? await repo.turns(owner, data.interviewId) : [],
          debriefReady: Boolean(await repo.debrief(owner, data.interviewId)),
          job: await repo.latestVoiceJob(owner, data.interviewId) };
      }
      else if (op === 'voice_correct' && request.method === 'POST') {
        if (guest) throw new InputError('Voice requires an account.', 403);
        if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 4000) {
          throw new InputError('Enter a correction of up to 4,000 characters.');
        }
        const job = await repo.correctVoiceTurn(owner, data.interviewId, data.turnId, data.text.trim());
        if (!job) throw new InputError('Voice turn not found', 404);
        result = { job };
      }
      else if (op === 'turn' && request.method === 'POST') {
        if (guest && data.answer?.length > 1000) throw new InputError('Guest answers are limited to 1,000 characters.');
        result = await service.turn(owner, data.interviewId, data.skip === true ? SKIP_ANSWER : data.answer, !guest);
        if (result.extractionPending) result.job = await repo.createJob(owner, 'rep_extract', { interviewId: data.interviewId });
      }
      else if (op === 'debrief' && request.method === 'POST') {
        if (guest) result = await service.debrief(owner, data.interviewId);
        else {
          if (!await repo.interview(owner, data.interviewId)) throw new InputError('Interview not found', 404);
          result = { job: await repo.pendingDebriefJob(owner, data.interviewId) ??
            await repo.createJob(owner, 'debrief', { interviewId: data.interviewId }) };
        }
      }
      else if (op === 'drill_call' && request.method === 'POST') result = await service.drillCall(owner, data.interviewId);
      else if (op === 'stronger_draft' && request.method === 'POST') {
        result = await service.strongerDraft(owner, data.interviewId);
      }
      else if (op === 'resolve_stronger_slot' && request.method === 'POST') {
        result = await service.resolveStrongerSlot(owner, data.slotId, data.action, data.value, data.reason);
      }
      else if (op === 'fact_gate_decision' && request.method === 'POST') {
        result = await service.decideFactGate(owner, data.interviewId, data.itemIndex, data.choice, data.note);
      }
      else if (op === 'history' && request.method === 'POST') result = await profileRepo.debrief(owner, data.interviewId);
      else return json({ error: 'not_found' }, 404);
      return json({ result, ...(guest ? { state: profileRepo.state } : {}) });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

// Plain English uses the same lane as the rest of the app (Vertex when VERTEX_API_KEY is set, which is
// what the daily spend cap meters), on the cheap lite model. No key at all means no model: the
// rules-based decoder answers instead.
export function plainAdapter(repo, env = process.env) {
  if (!providerFor(env).key) return null;
  return new GeminiAdapter({ repo, env: { ...env,
    GEMINI_MODEL_PRIMARY: 'gemini-3.5-flash-lite', GEMINI_MODEL_FALLBACK: 'gemini-3.5-flash-lite' } });
}

function plainCacheStore() {
  try { return getStore('plain-cache'); } catch { return null; }
}

export default async function handler(request, context) {
  const repo = new Repository(productionSql());
  const model = new GeminiAdapter({ repo });
  return createHandler({ repo, model, platformIp: context?.ip,
    blobStore: getStore('private-documents'), plainModel: plainAdapter(repo),
    plainCache: plainCacheStore() })(request);
}
