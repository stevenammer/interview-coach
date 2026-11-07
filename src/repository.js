import { randomUUID, createHash } from 'node:crypto';

export const id = () => randomUUID();
export const hash = (text) => createHash('sha256').update(text).digest('hex');
export const PER_USER_DAILY_CAP_FRACTION = 0.5;
export const FULL_VOICE_RESERVATION_MICROS = 30 * 200_000;
export const UPLOAD_LIMITS = Object.freeze({ pendingBytes: 20_000_000, accountBytes: 100_000_000,
  siteBytes: 1_000_000_000, accountFiles: 100, siteFiles: 10_000 });
export const JOB_STORAGE_LIMITS = Object.freeze({ accountBytes: 100_000_000, siteBytes: 1_000_000_000,
  accountActive: 100, siteActive: 1000, accountRecords: 10_000, siteRecords: 100_000 });
export const SOURCE_STORAGE_LIMITS = Object.freeze({ accountBytes: 100_000_000, siteBytes: 1_000_000_000,
  accountRecords: 1000, siteRecords: 10_000 });

export function perUserDailyCapMicros(capMicros, minimumReservationMicros = FULL_VOICE_RESERVATION_MICROS) {
  return Math.min(capMicros, Math.max(
    Math.floor(capMicros * PER_USER_DAILY_CAP_FRACTION),
    minimumReservationMicros,
  ));
}

export class Repository {
  constructor(sql, resourceLocked = false) {
    this.sql = sql;
    this.resourceLocked = resourceLocked;
  }

  async withResourceLock(work) {
    if (this.resourceLocked) return work(this);
    if (typeof this.sql.transaction !== 'function') throw new Error('Transactional resource accounting is unavailable');
    return this.sql.transaction(async (sql) => {
      const lock = await sql('SELECT id FROM resource_guard WHERE id=1 FOR UPDATE');
      if (!lock.length) throw new Error('Resource accounting is unavailable');
      return work(new Repository(sql, true));
    });
  }

  async userByName(name) {
    return (await this.sql('SELECT * FROM users WHERE normalized_username=$1', [name.toLowerCase()]))[0] ?? null;
  }

  async createUser(name, passwordHash) {
    const rows = await this.sql(
      'INSERT INTO users(id,username,normalized_username,password_hash) VALUES($1,$2,$3,$4) RETURNING id,username',
      [id(), name, name.toLowerCase(), passwordHash],
    );
    return rows[0];
  }

  async setPasswordHash(userId, passwordHash, currentTokenHash = null) {
    await this.sql('UPDATE users SET password_hash=$2 WHERE id=$1', [userId, passwordHash]);
    if (currentTokenHash) {
      await this.sql('UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND token_hash<>$2 AND revoked_at IS NULL',
        [userId, currentTokenHash]);
    } else await this.sql('UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [userId]);
  }

  async createSession(userId, tokenHash, expiresAt) {
    await this.sql('INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4)',
      [id(), userId, tokenHash, expiresAt]);
  }

  async session(tokenHash) {
    return (await this.sql(`SELECT u.id,u.username FROM auth_sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()`, [tokenHash]))[0] ?? null;
  }

  async revoke(tokenHash) {
    await this.sql('UPDATE auth_sessions SET revoked_at=now() WHERE token_hash=$1', [tokenHash]);
  }

  async revokeAllSessions(userId, currentTokenHash = null) {
    if (currentTokenHash) await this.sql('UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND token_hash<>$2 AND revoked_at IS NULL',
      [userId, currentTokenHash]);
    else await this.sql('UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [userId]);
  }

  async addSource(owner, kind, title, text, parent = null, pageOffsets = []) {
    return this.withResourceLock(async (repo) => {
      const bytes = Buffer.byteLength(title, 'utf8') + Buffer.byteLength(text, 'utf8');
      const totals = (await repo.sql(`SELECT
        coalesce(sum(octet_length(title)+octet_length(text)) FILTER (WHERE user_id=$1),0)::bigint AS account_bytes,
        coalesce(sum(octet_length(title)+octet_length(text)),0)::bigint AS site_bytes,
        count(*) FILTER (WHERE user_id=$1)::int AS account_records,count(*)::int AS site_records FROM sources`, [owner]))[0];
      if (Number(totals.account_bytes) + bytes > SOURCE_STORAGE_LIMITS.accountBytes ||
          Number(totals.site_bytes) + bytes > SOURCE_STORAGE_LIMITS.siteBytes ||
          totals.account_records >= SOURCE_STORAGE_LIMITS.accountRecords || totals.site_records >= SOURCE_STORAGE_LIMITS.siteRecords) {
        const error = new Error('Saved source storage is full. Remove old source documents before adding more.');
        error.status = 429; error.code = 'source_storage_full'; throw error;
      }
      return (await repo.sql(`INSERT INTO sources(id,user_id,kind,title,text,content_hash,parent_source_id)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id(), owner, kind, title, text, hash(text), parent]))[0];
    });
  }

  async latestResume(owner) {
    return (await this.sql("SELECT text FROM sources WHERE user_id=$1 AND kind='resume' ORDER BY created_at DESC LIMIT 1", [owner]))[0]?.text ?? null;
  }

  async setPageOffsets(owner, sourceId, offsets) {
    await this.sql('UPDATE sources SET page_offsets_json=$3::jsonb WHERE user_id=$1 AND id=$2',
      [owner, sourceId, JSON.stringify(offsets)]);
  }

  async initUpload(owner, sourceId, name, mimeType, byteSize, chunkCount) {
    return this.withResourceLock(async (repo) => {
      const totals = (await repo.sql(`SELECT
        coalesce(sum(byte_size) FILTER (WHERE user_id=$1 AND status='pending'),0)::bigint AS pending,
        coalesce(sum(byte_size) FILTER (WHERE user_id=$1),0)::bigint AS account,
        coalesce(sum(byte_size),0)::bigint AS site,
        count(*) FILTER (WHERE user_id=$1)::int AS account_files,count(*)::int AS site_files FROM uploads`, [owner]))[0];
      if (Number(totals.pending) + byteSize > UPLOAD_LIMITS.pendingBytes ||
          Number(totals.account) + byteSize > UPLOAD_LIMITS.accountBytes ||
          Number(totals.site) + byteSize > UPLOAD_LIMITS.siteBytes ||
          totals.account_files >= UPLOAD_LIMITS.accountFiles || totals.site_files >= UPLOAD_LIMITS.siteFiles) {
        const error = new Error('Upload storage is full. Remove saved files before adding more.');
        error.status = 429; error.code = 'upload_storage_full'; throw error;
      }
      if ((await repo.sourceUploads(owner, sourceId)).some((upload) => upload.status === 'ready')) {
        const error = new Error('This source already has an original file.'); error.status = 400; throw error;
      }
      const uploadId = id();
      const prefix = `${owner}/${uploadId}`;
      await repo.sql(`INSERT INTO uploads(id,user_id,source_id,chunk_count,byte_size,mime_type)
        VALUES($1,$2,$3,$4,$5,$6)`, [uploadId, owner, sourceId, chunkCount, byteSize, mimeType]);
      await repo.sql(`UPDATE sources SET original_name=$3,mime_type=$4,blob_prefix=$5
        WHERE user_id=$1 AND id=$2`, [owner, sourceId, name, mimeType, prefix]);
      return { id: uploadId, prefix, chunkCount };
    });
  }

  async expirePendingUploads(owner, now = new Date(), blobStore = null) {
    return this.withResourceLock(async (repo) => {
      const expired = await repo.sql(`SELECT id,chunk_count FROM uploads WHERE user_id=$1 AND status='pending'
        AND created_at<$2::timestamptz-interval '1 hour'`, [owner, now]);
      if (!blobStore && expired.length) throw new Error('Blob cleanup is unavailable');
      for (const upload of expired) {
        for (let part = 0; part < upload.chunk_count; part += 1) await blobStore.delete(`${owner}/${upload.id}/${part}`);
        await repo.sql('DELETE FROM uploads WHERE user_id=$1 AND id=$2', [owner, upload.id]);
      }
      return expired;
    });
  }

  async pendingUploadBytes(owner) {
    return Number((await this.sql(`SELECT coalesce(sum(byte_size),0)::bigint AS bytes FROM uploads
      WHERE user_id=$1 AND status='pending'`, [owner]))[0].bytes);
  }

  async upload(owner, uploadId) {
    return (await this.sql('SELECT * FROM uploads WHERE user_id=$1 AND id=$2', [owner, uploadId]))[0] ?? null;
  }

  async saveChunk(owner, uploadId, part, byteSize) {
    await this.sql(`INSERT INTO upload_chunks(upload_id,user_id,part,byte_size)
      VALUES($1,$2,$3,$4) ON CONFLICT(upload_id,part) DO UPDATE SET byte_size=$4`,
    [uploadId, owner, part, byteSize]);
  }

  async finishUpload(owner, uploadId) {
    const rows = await this.sql(`SELECT u.chunk_count,u.byte_size,count(c.part)::int AS pieces,
      coalesce(sum(c.byte_size),0)::int AS bytes FROM uploads u
      LEFT JOIN upload_chunks c ON c.user_id=u.user_id AND c.upload_id=u.id
      WHERE u.user_id=$1 AND u.id=$2 GROUP BY u.id`, [owner, uploadId]);
    const item = rows[0];
    if (!item || item.pieces !== item.chunk_count || item.bytes !== item.byte_size) return false;
    await this.sql("UPDATE uploads SET status='ready' WHERE user_id=$1 AND id=$2", [owner, uploadId]);
    return true;
  }

  async sourceUploads(owner, sourceId) {
    return this.sql('SELECT * FROM uploads WHERE user_id=$1 AND source_id=$2', [owner, sourceId]);
  }

  async allUploads(owner) {
    return this.sql('SELECT * FROM uploads WHERE user_id=$1', [owner]);
  }

  async addWritingSample(owner, title, text) {
    return this.addSource(owner, 'writing_sample', title, text);
  }

  async writingSamples(owner) {
    return this.sql("SELECT id,title,text FROM sources WHERE user_id=$1 AND kind='writing_sample' ORDER BY created_at", [owner]);
  }

  async writingProfile(owner) {
    const profile = (await this.sql('SELECT * FROM writing_profiles WHERE user_id=$1', [owner]))[0] ?? null;
    return { preferences: profile?.preferences ?? '', enabled: profile?.enabled ?? false,
      samples: await this.writingSamples(owner) };
  }

  async coachNotes(owner, workspaceId = null) {
    // Optional historical tables must be checked before querying inside a transaction.
    if (!(await this.sql("SELECT to_regclass('coach_notes') AS name"))[0]?.name) return [];
    return this.sql(`SELECT * FROM coach_notes WHERE user_id=$1 AND
      ($2::uuid IS NULL OR workspace_id IS NULL OR workspace_id=$2) ORDER BY created_at DESC`, [owner, workspaceId]);
  }

  async addCoachNote(owner, { workspaceId = null, interviewId = null, text }) {
    return (await this.sql(`INSERT INTO coach_notes(id,user_id,workspace_id,interview_id,text)
      VALUES($1,$2,$3,$4,$5) RETURNING *`, [id(), owner, workspaceId, interviewId, text]))[0];
  }

  async updateCoachNote(owner, noteId, { text, active }) {
    return (await this.sql(`UPDATE coach_notes SET text=COALESCE($3,text), active=COALESCE($4,active),
      updated_at=now() WHERE user_id=$1 AND id=$2 RETURNING *`, [owner, noteId, text, active]))[0] ?? null;
  }

  async deleteCoachNote(owner, noteId) {
    return (await this.sql('DELETE FROM coach_notes WHERE user_id=$1 AND id=$2 RETURNING id', [owner, noteId]))[0] ?? null;
  }

  async prepPack(owner, workspaceId) {
    return (await this.sql('SELECT * FROM prep_packs WHERE user_id=$1 AND workspace_id=$2', [owner, workspaceId]))[0] ?? null;
  }

  async savePrepPack(owner, workspaceId, inputHash) {
    return (await this.sql(`INSERT INTO prep_packs(id,user_id,workspace_id,input_hash) VALUES($1,$2,$3,$4)
      ON CONFLICT(user_id,workspace_id) DO UPDATE SET input_hash=$4,updated_at=now() RETURNING *`, [id(), owner, workspaceId, inputHash]))[0];
  }

  async prepSections(owner, packId) {
    return this.sql('SELECT * FROM prep_pack_sections WHERE user_id=$1 AND prep_pack_id=$2 ORDER BY created_at,section_key', [owner, packId]);
  }

  async savePrepSection(owner, packId, section) {
    return (await this.sql(`INSERT INTO prep_pack_sections(id,user_id,prep_pack_id,section_key,title,kind,input_hash,status,content_json,error_code)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) ON CONFLICT(user_id,prep_pack_id,section_key) DO UPDATE
      SET title=$5,kind=$6,input_hash=$7,status=$8,content_json=$9::jsonb,error_code=$10,updated_at=now() RETURNING *`,
    [id(), owner, packId, section.key, section.title, section.kind, section.inputHash, section.status,
      JSON.stringify(section.content ?? null), section.errorCode ?? null]))[0];
  }

  async markPrepSectionsStale(owner, packId, inputHash) {
    await this.sql(`UPDATE prep_pack_sections SET status='stale',updated_at=now()
      WHERE user_id=$1 AND prep_pack_id=$2 AND input_hash<>$3 AND status<>'stale'`,
    [owner, packId, inputHash]);
  }

  async prepSection(owner, packId, sectionKey) {
    return (await this.sql(`SELECT * FROM prep_pack_sections
      WHERE user_id=$1 AND prep_pack_id=$2 AND section_key=$3`, [owner, packId, sectionKey]))[0] ?? null;
  }

  async attachPrepJob(owner, packId, sectionKey, jobId) {
    return (await this.sql(`UPDATE prep_pack_sections SET job_id=$4,status='queued',error_code=NULL,updated_at=now()
      WHERE user_id=$1 AND prep_pack_id=$2 AND section_key=$3 RETURNING *`,
    [owner, packId, sectionKey, jobId]))[0] ?? null;
  }

  async failPrepSection(owner, workspaceId, sectionKey, errorCode) {
    await this.sql(`UPDATE prep_pack_sections s SET status='failed',error_code=$4,updated_at=now()
      FROM prep_packs p WHERE s.user_id=$1 AND p.user_id=$1 AND p.workspace_id=$2
      AND s.prep_pack_id=p.id AND s.section_key=$3`, [owner, workspaceId, sectionKey, errorCode]);
  }

  async saveWritingProfile(owner, preferences, enabled) {
    await this.sql(`INSERT INTO writing_profiles(user_id,preferences,enabled)
      VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE
      SET preferences=$2,enabled=$3,updated_at=now()`, [owner, preferences, enabled]);
    return this.writingProfile(owner);
  }

  async createJob(owner, kind, input) {
    return this.withResourceLock((repo) => repo.createJobLocked(owner, kind, input));
  }

  async createJobLocked(owner, kind, input) {
    const inputHash = hash(JSON.stringify(input));
    const existing = (await this.sql(`SELECT id,kind,status FROM model_jobs WHERE user_id=$1 AND kind=$2
      AND input_hash=$3 AND status IN ('queued','running') AND created_at>now()-interval '5 minutes'
      ORDER BY created_at DESC LIMIT 1`,
    [owner, kind, inputHash]))[0];
    if (existing) return existing;
    const bytes = Number((await this.sql('SELECT octet_length($1::jsonb::text) AS bytes', [JSON.stringify(input)]))[0].bytes);
    const totals = (await this.sql(`SELECT
      coalesce(sum(octet_length(input_json::text)+coalesce(octet_length(result_json::text),0)) FILTER (WHERE user_id=$1),0)::bigint AS account_bytes,
      coalesce(sum(octet_length(input_json::text)+coalesce(octet_length(result_json::text),0)),0)::bigint AS site_bytes,
      count(*) FILTER (WHERE user_id=$1 AND status IN ('queued','running'))::int AS account_active,
      count(*) FILTER (WHERE status IN ('queued','running'))::int AS site_active,
      count(*) FILTER (WHERE user_id=$1)::int AS account_records,count(*)::int AS site_records FROM model_jobs`, [owner]))[0];
    if (Number(totals.account_bytes) + bytes > JOB_STORAGE_LIMITS.accountBytes ||
        Number(totals.site_bytes) + bytes > JOB_STORAGE_LIMITS.siteBytes ||
        totals.account_active >= JOB_STORAGE_LIMITS.accountActive || totals.site_active >= JOB_STORAGE_LIMITS.siteActive ||
        totals.account_records >= JOB_STORAGE_LIMITS.accountRecords || totals.site_records >= JOB_STORAGE_LIMITS.siteRecords) {
      const error = new Error('Saved AI job storage is full. Finish queued work or ask the site operator to remove old jobs.');
      error.status = 429; error.code = 'job_storage_full'; throw error;
    }
    return (await this.sql(`INSERT INTO model_jobs(id,user_id,kind,input_json,input_hash)
      VALUES($1,$2,$3,$4::jsonb,$5) RETURNING id,kind,status`,
    [id(), owner, kind, JSON.stringify(input), inputHash]))[0];
  }

  async pendingDebriefJob(owner, interviewId) {
    await this.expireStaleJobs(owner);
    return (await this.sql(`SELECT id,kind,status FROM model_jobs
      WHERE user_id=$1 AND kind='debrief' AND status IN ('queued','running')
      AND input_json->>'interviewId'=$2 ORDER BY created_at DESC LIMIT 1`, [owner, interviewId]))[0] ?? null;
  }

  async job(owner, jobId) {
    await this.expireStaleJobs(owner);
    return (await this.sql(`SELECT id,kind,status,result_json,error_code,created_at
      FROM model_jobs WHERE user_id=$1 AND id=$2`, [owner, jobId]))[0] ?? null;
  }

  async claimJob(owner, jobId) {
    return (await this.sql(`UPDATE model_jobs SET status='running',attempts=attempts+1,
      started_at=now() WHERE user_id=$1 AND id=$2 AND status='queued'
      RETURNING id,kind,input_json`, [owner, jobId]))[0] ?? null;
  }

  // A serverless worker can disappear after claiming a job. Reading the job is the recovery
  // point, so no scheduler is required for people to get a useful retry.
  async expireStaleJobs(owner, now = new Date()) {
    await this.sql(`UPDATE model_jobs SET status='failed',error_code='timed_out',finished_at=$2
      WHERE user_id=$1 AND status='running'
      AND started_at < $2::timestamptz - interval '10 minutes'`, [owner, now]);
    if ((await this.sql("SELECT to_regclass('prep_pack_sections') AS name"))[0]?.name) {
      await this.sql(`UPDATE prep_pack_sections s SET status='failed',error_code='timed_out',updated_at=$2
        FROM model_jobs j WHERE s.user_id=$1 AND j.user_id=$1 AND s.job_id=j.id
        AND j.status='failed' AND j.error_code='timed_out' AND s.status='running'`, [owner, now]);
    }
  }

  async finishJob(owner, jobId, result, errorCode = null) {
    await this.withResourceLock(async (repo) => {
      const job = (await repo.sql("SELECT input_json FROM model_jobs WHERE user_id=$1 AND id=$2 AND status='running'", [owner, jobId]))[0];
      if (!job) return;
      const serialized = JSON.stringify(result);
      const bytes = Number((await repo.sql('SELECT octet_length($1::jsonb::text)+octet_length($2::jsonb::text) AS bytes',
        [serialized, errorCode ? JSON.stringify(job.input_json) : '{}']))[0].bytes);
      const totals = (await repo.sql(`SELECT
        coalesce(sum(octet_length(input_json::text)+coalesce(octet_length(result_json::text),0)) FILTER (WHERE user_id=$1),0)::bigint AS account_bytes,
        coalesce(sum(octet_length(input_json::text)+coalesce(octet_length(result_json::text),0)),0)::bigint AS site_bytes
        FROM model_jobs WHERE id<>$2`, [owner, jobId]))[0];
      if (Number(totals.account_bytes) + bytes > JOB_STORAGE_LIMITS.accountBytes || Number(totals.site_bytes) + bytes > JOB_STORAGE_LIMITS.siteBytes) {
        await repo.sql("UPDATE model_jobs SET status='failed',input_json='{}'::jsonb,result_json=NULL,error_code='job_storage_full',finished_at=now() WHERE user_id=$1 AND id=$2 AND status='running'", [owner, jobId]);
        return;
      }
      await repo.sql(`UPDATE model_jobs SET status=$3,result_json=$4::jsonb,error_code=$5,
        input_json=CASE WHEN $5::text IS NULL THEN '{}'::jsonb ELSE input_json END,finished_at=now()
        WHERE user_id=$1 AND id=$2 AND status='running'`,
      [owner, jobId, errorCode ? 'failed' : 'done', serialized, errorCode]);
    });
  }

  async retryJob(owner, jobId) {
    return (await this.sql(`UPDATE model_jobs SET status='queued',error_code=NULL,started_at=NULL
      WHERE user_id=$1 AND id=$2 AND status='failed' AND attempts<3 AND
      error_code IN ('model_unavailable','invalid_model_output','spend_cap_reached','accounting_unavailable','timed_out')
      RETURNING id,kind,status`, [owner, jobId]))[0] ?? null;
  }

  async source(owner, sourceId) {
    return (await this.sql('SELECT * FROM sources WHERE user_id=$1 AND id=$2', [owner, sourceId]))[0] ?? null;
  }

  async addWorkspace(owner, jdSourceId, label) {
    return (await this.sql(`INSERT INTO workspaces(id,user_id,jd_source_id,label)
      VALUES($1,$2,$3,$4) RETURNING *`, [id(), owner, jdSourceId, label]))[0];
  }

  async workspace(owner, workspaceId) {
    return (await this.sql('SELECT * FROM workspaces WHERE user_id=$1 AND id=$2', [owner, workspaceId]))[0] ?? null;
  }

  async workspaces(owner) {
    return this.sql(`SELECT w.*,s.text AS jd_text FROM workspaces w
      JOIN sources s ON s.user_id=w.user_id AND s.id=w.jd_source_id
      WHERE w.user_id=$1 ORDER BY w.created_at DESC`, [owner]);
  }

  async workspaceProgress(owner, workspaceId) {
    const rows = await this.sql(`SELECT
      (SELECT count(*)::int FROM facts WHERE user_id=$1 AND (workspace_id IS NULL OR workspace_id=$2)
        AND domain='candidate' AND review_state='pending' AND lifecycle='active') AS pending_facts,
      EXISTS(SELECT 1 FROM prep_packs WHERE user_id=$1 AND workspace_id=$2) AS has_prep_pack,
      EXISTS(SELECT 1 FROM interviews WHERE user_id=$1 AND workspace_id=$2) AS has_practice,
      EXISTS(SELECT 1 FROM interviews i JOIN debriefs d ON d.user_id=i.user_id AND d.interview_id=i.id
        WHERE i.user_id=$1 AND i.workspace_id=$2) AS has_debrief,
      (SELECT i.id FROM interviews i JOIN debriefs d ON d.user_id=i.user_id AND d.interview_id=i.id
        WHERE i.user_id=$1 AND i.workspace_id=$2 ORDER BY d.created_at DESC LIMIT 1) AS latest_debrief_interview_id`,
    [owner, workspaceId]);
    return rows[0];
  }

  async setWorkspacePreferences(owner, workspaceId, remotePreference, listingWorkMode) {
    return (await this.sql(`UPDATE workspaces SET remote_preference=$3,listing_work_mode=$4,
      updated_at=now() WHERE user_id=$1 AND id=$2 RETURNING *`,
    [owner, workspaceId, remotePreference, listingWorkMode]))[0] ?? null;
  }

  async setJobComparison(owner, workspaceId, { payDetails, benefitsDetails, learnedDetails }) {
    return (await this.sql(`UPDATE workspaces SET pay_details=$3,benefits_details=$4,learned_details=$5,
      updated_at=now() WHERE user_id=$1 AND id=$2 RETURNING *`,
    [owner, workspaceId, payDetails, benefitsDetails, learnedDetails]))[0] ?? null;
  }

  async setVoiceContext(owner, workspaceId, roleTitle, companyName) {
    return (await this.sql(`UPDATE workspaces SET role_title=$3,company_name=$4,updated_at=now()
      WHERE user_id=$1 AND id=$2 RETURNING *`, [owner, workspaceId, roleTitle, companyName]))[0] ?? null;
  }

  async setInterviewDate(owner, workspaceId, date) {
    return (await this.sql('UPDATE workspaces SET interview_date=$3 WHERE user_id=$1 AND id=$2 RETURNING *',
      [owner, workspaceId, date]))[0] ?? null;
  }

  async updateJobHunt(owner, workspaceId, fields) {
    return (await this.sql(`UPDATE workspaces SET hunt_status=COALESCE($3,hunt_status),
      applied_on=$4::date, next_step=$5, next_step_on=$6::date,
      hunt_notes=$7, posting_link=$8, updated_at=now() WHERE user_id=$1 AND id=$2 RETURNING *`,
    [owner, workspaceId, fields.status, fields.appliedOn, fields.nextStep, fields.nextStepOn,
      fields.notes, fields.postingLink]))[0] ?? null;
  }

  async addJobHuntHistory(owner, workspaceId, { action, note = null, happenedOn }) {
    return (await this.sql(`INSERT INTO job_hunt_history(id,user_id,workspace_id,action,note,happened_on)
      VALUES($1,$2,$3,$4,$5,$6::date) RETURNING *`, [id(), owner, workspaceId, action, note, happenedOn]))[0];
  }

  async jobHuntHistory(owner, workspaceId) {
    return this.sql('SELECT * FROM job_hunt_history WHERE user_id=$1 AND workspace_id=$2 ORDER BY created_at DESC', [owner, workspaceId]);
  }

  async deleteJobHuntHistory(owner, historyId) {
    return (await this.sql('DELETE FROM job_hunt_history WHERE user_id=$1 AND id=$2 RETURNING id', [owner, historyId]))[0] ?? null;
  }

  async verifiedCompanyFacts(owner, workspaceId) {
    return this.sql(`SELECT id,quote,source_url,checked_at FROM verified_company_facts
      WHERE user_id=$1 AND workspace_id=$2 AND status='verified' ORDER BY checked_at DESC`,
    [owner, workspaceId]);
  }

  async saveImmersion(owner, workspaceId, plan, state) {
    return (await this.sql(`INSERT INTO immersions(id,user_id,workspace_id,plan_json,state_json)
      VALUES($1,$2,$3,$4::jsonb,$5::jsonb) RETURNING *`,
    [id(), owner, workspaceId, JSON.stringify(plan), JSON.stringify(state)]))[0];
  }

  async immersion(owner, immersionId) {
    return (await this.sql('SELECT * FROM immersions WHERE user_id=$1 AND id=$2',
      [owner, immersionId]))[0] ?? null;
  }

  async latestImmersion(owner, workspaceId) {
    return (await this.sql(`SELECT * FROM immersions WHERE user_id=$1 AND workspace_id=$2
      ORDER BY updated_at DESC LIMIT 1`, [owner, workspaceId]))[0] ?? null;
  }

  async updateImmersion(owner, immersionId, state) {
    return (await this.sql(`UPDATE immersions SET state_json=$3::jsonb,updated_at=now()
      WHERE user_id=$1 AND id=$2 RETURNING *`, [owner, immersionId, JSON.stringify(state)]))[0] ?? null;
  }

  async addDrillCard(owner, workspaceId, kind, targetSeconds, cue, factIds, schedule) {
    return (await this.sql(`INSERT INTO drill_cards(id,user_id,workspace_id,kind,target_seconds,cue,fact_ids,schedule_json)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) RETURNING *`,
    [id(), owner, workspaceId, kind, targetSeconds, cue, JSON.stringify(factIds), JSON.stringify(schedule)]))[0];
  }

  async drillCards(owner, workspaceId) {
    return this.sql("SELECT * FROM drill_cards WHERE user_id=$1 AND workspace_id=$2 AND status='active' ORDER BY created_at",
      [owner, workspaceId]);
  }

  async drillCard(owner, cardId) {
    return (await this.sql('SELECT * FROM drill_cards WHERE user_id=$1 AND id=$2', [owner, cardId]))[0] ?? null;
  }

  async updateDrillCue(owner, cardId, cue, schedule = null) {
    if (schedule == null) return (await this.sql('UPDATE drill_cards SET cue=$3 WHERE user_id=$1 AND id=$2 RETURNING *',
      [owner, cardId, cue]))[0] ?? null;
    return (await this.sql('UPDATE drill_cards SET cue=$3,schedule_json=$4::jsonb WHERE user_id=$1 AND id=$2 RETURNING *',
      [owner, cardId, cue, JSON.stringify(schedule)]))[0] ?? null;
  }

  async saveDrillReview(owner, cardId, answer, hitIds, missedIds, rating, schedule) {
    await this.sql(`INSERT INTO drill_reviews(id,user_id,card_id,answer,hit_ids,missed_ids,rating)
      VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,
    [id(), owner, cardId, answer, JSON.stringify(hitIds), JSON.stringify(missedIds), rating]);
    await this.sql('UPDATE drill_cards SET schedule_json=$3::jsonb WHERE user_id=$1 AND id=$2',
      [owner, cardId, JSON.stringify(schedule)]);
  }

  async latestPlan(owner, workspaceId) {
    return (await this.sql('SELECT plan_json FROM interviews WHERE user_id=$1 AND workspace_id=$2 ORDER BY started_at DESC LIMIT 1',
      [owner, workspaceId]))[0]?.plan_json ?? [];
  }

  async saveRealInterview(owner, workspaceId, captureKind, sourceId, questions, storyFactIds,
    stumped, matchedCount) {
    return (await this.sql(`INSERT INTO real_interviews(id,user_id,workspace_id,capture_kind,source_id,
      questions_json,story_fact_ids_json,stumped_json,asked_count,matched_count)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10) RETURNING *`,
    [id(), owner, workspaceId, captureKind, sourceId, JSON.stringify(questions),
      JSON.stringify(storyFactIds), JSON.stringify(stumped), questions.length, matchedCount]))[0];
  }

  async realInterviews(owner, workspaceId) {
    return this.sql('SELECT * FROM real_interviews WHERE user_id=$1 AND workspace_id=$2 ORDER BY created_at DESC',
      [owner, workspaceId]);
  }

  async replaceRequirements(owner, workspaceId, jdSourceId, items) {
    await this.sql(`DELETE FROM requirement_match_facts WHERE user_id=$1 AND match_id IN
      (SELECT m.id FROM requirement_matches m JOIN requirements r ON r.user_id=m.user_id
       AND r.id=m.requirement_id WHERE r.user_id=$1 AND r.workspace_id=$2)`, [owner, workspaceId]);
    await this.sql(`DELETE FROM requirement_matches WHERE user_id=$1 AND requirement_id IN
      (SELECT id FROM requirements WHERE user_id=$1 AND workspace_id=$2)`, [owner, workspaceId]);
    await this.sql('DELETE FROM requirements WHERE user_id=$1 AND workspace_id=$2', [owner, workspaceId]);
    for (const item of items) {
      const spanId = id();
      await this.sql(`INSERT INTO source_spans(id,user_id,source_id,start_offset,end_offset,verbatim_quote)
        VALUES($1,$2,$3,$4,$5,$6)`, [spanId, owner, jdSourceId, item.start, item.end, item.quote]);
      const requirementId = id();
      await this.sql(`INSERT INTO requirements(id,user_id,workspace_id,span_id,text,type,competency,evidence_needed)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [requirementId, owner, workspaceId, spanId, item.quote, item.type, item.competency, item.evidenceNeeded]);
      const matchId = id();
      await this.sql(`INSERT INTO requirement_matches(id,user_id,requirement_id,category,rationale)
        VALUES($1,$2,$3,$4,$5)`, [matchId, owner, requirementId, item.category, item.rationale]);
      for (const factId of item.factIds) await this.sql(`INSERT INTO requirement_match_facts(id,user_id,match_id,fact_id)
        VALUES($1,$2,$3,$4)`, [id(), owner, matchId, factId]);
    }
    return this.requirements(owner, workspaceId);
  }

  async requirements(owner, workspaceId) {
    return this.sql(`SELECT r.*,m.category,m.rationale,s.source_id,s.start_offset,s.end_offset,
      coalesce(jsonb_agg(mf.fact_id) FILTER (WHERE mf.fact_id IS NOT NULL),'[]'::jsonb) AS fact_ids
      FROM requirements r JOIN requirement_matches m ON m.user_id=r.user_id AND m.requirement_id=r.id
      JOIN source_spans s ON s.user_id=r.user_id AND s.id=r.span_id
      LEFT JOIN requirement_match_facts mf ON mf.user_id=m.user_id AND mf.match_id=m.id
      WHERE r.user_id=$1 AND r.workspace_id=$2
      GROUP BY r.id,m.id,s.id ORDER BY s.start_offset,s.end_offset,r.created_at,r.id`, [owner, workspaceId]);
  }

  async addFact(owner, data) {
    const factId = id();
    await this.sql(`INSERT INTO facts(id,user_id,workspace_id,domain,subject,predicate,value_json,qualifiers_json,
      display_text,status,review_state,supersedes_fact_id,confirmed_at,discrepancy_note,proposed_by)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14,$15)`,
    [factId, owner, data.workspaceId ?? null, data.domain ?? 'candidate', data.subject, data.predicate,
      JSON.stringify(data.value), JSON.stringify(data.qualifiers ?? {}), data.displayText,
      data.status, data.reviewState, data.supersedes ?? null,
      data.reviewState === 'accepted' ? new Date() : null,
      data.discrepancyNote ?? null, data.proposedBy]);
    if (data.sourceId != null) {
      const spanId = id();
      await this.sql(`INSERT INTO source_spans(id,user_id,source_id,start_offset,end_offset,verbatim_quote,page_number,section_label)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [spanId, owner, data.sourceId, data.start, data.end,
        data.quote, data.pageNumber ?? null, data.sectionLabel ?? null]);
      await this.sql(`INSERT INTO fact_evidence(id,user_id,fact_id,span_id,relation)
        VALUES($1,$2,$3,$4,$5)`, [id(), owner, factId, spanId, data.relation ?? 'supports']);
    }
    await this.event(owner, factId, 'proposed', null, data.proposedBy);
    return factId;
  }

  async event(owner, factId, type, replacement = null, actor = 'user', reason = null) {
    await this.sql(`INSERT INTO fact_events(id,user_id,fact_id,event_type,replacement_fact_id,actor_kind,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [id(), owner, factId, type, replacement, actor, reason]);
  }

  async facts(owner, workspaceId = null) {
    const rows = await this.sql(`SELECT f.*,s.verbatim_quote,s.start_offset,s.end_offset,s.source_id,s.page_number,s.section_label,
      src.title AS source_title,src.text AS source_text
      FROM facts f LEFT JOIN fact_evidence e ON e.user_id=f.user_id AND e.fact_id=f.id
      LEFT JOIN source_spans s ON s.user_id=e.user_id AND s.id=e.span_id
      LEFT JOIN sources src ON src.user_id=s.user_id AND src.id=s.source_id
      WHERE f.user_id=$1 AND (f.workspace_id IS NULL OR f.workspace_id=$2)
      ORDER BY f.created_at,f.id`, [owner, workspaceId]);
    return rows.map(({ source_text: sourceText, ...fact }) => {
      if (!sourceText || fact.start_offset == null) return fact;
      const lineStart = sourceText.lastIndexOf('\n', fact.start_offset - 1) + 1;
      const nextBreak = sourceText.indexOf('\n', fact.end_offset);
      const lineEnd = nextBreak < 0 ? sourceText.length : nextBreak;
      return { ...fact, line_quote: sourceText.slice(lineStart, lineEnd),
        line_start: lineStart, line_end: lineEnd };
    });
  }

  async factConflictReviews(owner, workspaceId = null) {
    return this.sql(`SELECT * FROM fact_conflict_reviews WHERE user_id=$1
      AND (($2::uuid IS NULL AND workspace_id IS NULL) OR workspace_id=$2 OR workspace_id IS NULL)
      ORDER BY updated_at DESC`, [owner, workspaceId]);
  }

  async createFactConflictReview(owner, { workspaceId, factAId, factBId, fingerprint, status = 'open', reason }) {
    const ordered = [factAId, factBId].sort();
    const history = [{ action: 'reported', status, reason, at: new Date().toISOString() }];
    await this.sql(`INSERT INTO fact_conflict_reviews(id,user_id,workspace_id,fact_a_id,fact_b_id,
      content_fingerprint,status,reason,review_history) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
      ON CONFLICT(user_id,fact_a_id,fact_b_id,content_fingerprint) DO NOTHING`,
    [id(), owner, workspaceId ?? null, ordered[0], ordered[1], fingerprint, status, reason, JSON.stringify(history)]);
    return (await this.sql(`SELECT * FROM fact_conflict_reviews WHERE user_id=$1 AND fact_a_id=$2
      AND fact_b_id=$3 AND content_fingerprint=$4`, [owner, ordered[0], ordered[1], fingerprint]))[0] ?? null;
  }

  async updateFactConflictReview(owner, reviewId, fingerprint, status, reason) {
    const event = JSON.stringify([{ action: status, status, reason, at: new Date().toISOString() }]);
    return (await this.sql(`UPDATE fact_conflict_reviews SET status=$4,reason=$5,
      context_note=CASE WHEN $4='context_review' THEN $5 ELSE context_note END,
      review_history=review_history || $6::jsonb,updated_at=now()
      WHERE user_id=$1 AND id=$2 AND content_fingerprint=$3 RETURNING *`,
    [owner, reviewId, fingerprint, status, reason, event]))[0] ?? null;
  }

  async resolveFactConflictReviewsForFact(owner, factId, reason) {
    const event = JSON.stringify([{ action: 'fact_set_aside_or_corrected', status: 'resolved', reason, at: new Date().toISOString() }]);
    await this.sql(`UPDATE fact_conflict_reviews SET status='resolved',reason=$3,
      review_history=review_history || $4::jsonb,updated_at=now()
      WHERE user_id=$1 AND status IN ('open','context_review') AND (fact_a_id=$2 OR fact_b_id=$2)`,
    [owner, factId, reason, event]);
  }

  async fact(owner, factId) {
    return (await this.sql('SELECT * FROM facts WHERE user_id=$1 AND id=$2', [owner, factId]))[0] ?? null;
  }

  async review(owner, factId, action) {
    const fact = await this.fact(owner, factId);
    if (!fact || fact.lifecycle !== 'active') return null;
    if (action === 'confirm') {
      await this.sql(`UPDATE facts SET review_state='accepted',status='user_confirmed',confirmed_at=now()
        WHERE user_id=$1 AND id=$2`, [owner, factId]);
      await this.event(owner, factId, 'confirmed');
    } else if (action === 'reject') {
      await this.sql(`UPDATE facts SET review_state='rejected' WHERE user_id=$1 AND id=$2`, [owner, factId]);
      await this.event(owner, factId, 'rejected');
    }
    return this.fact(owner, factId);
  }

  async supersede(owner, factId, replacementId, reason) {
    await this.sql(`UPDATE facts SET lifecycle='superseded' WHERE user_id=$1 AND id=$2`, [owner, factId]);
    await this.event(owner, factId, 'superseded', replacementId, 'user', reason);
    await this.sql(`UPDATE artifacts SET status='invalidated' WHERE user_id=$1 AND id IN
      (SELECT c.artifact_id FROM artifact_claim_facts cf JOIN artifact_claims c
      ON c.user_id=cf.user_id AND c.id=cf.claim_id WHERE cf.user_id=$1 AND cf.fact_id=$2)`, [owner, factId]);
    await this.sql("UPDATE drill_cards SET status='invalidated' WHERE user_id=$1 AND fact_ids ? $2", [owner, factId]);
    await this.sql('DELETE FROM immersions WHERE user_id=$1', [owner]);
  }

  async events(owner, factId) {
    return this.sql('SELECT * FROM fact_events WHERE user_id=$1 AND fact_id=$2 ORDER BY created_at', [owner, factId]);
  }

  async createInterview(owner, workspaceId, questions, persona = 'hiring_manager', difficulty = 2, practiceMode = 'mock') {
    return (await this.sql(`INSERT INTO interviews(id,user_id,workspace_id,plan_json,persona,difficulty,practice_mode)
      VALUES($1,$2,$3,$4::jsonb,$5,$6,$7) RETURNING *`,
    [id(), owner, workspaceId, JSON.stringify(questions), persona, difficulty, practiceMode]))[0];
  }

  async setInterviewFocus(owner, interviewId, focus) {
    await this.sql('UPDATE interviews SET focus=$3 WHERE user_id=$1 AND id=$2', [owner, interviewId, focus]);
  }

  async markVoiceInterview(owner, interviewId) {
    await this.sql("UPDATE interviews SET mode='voice' WHERE user_id=$1 AND id=$2", [owner, interviewId]);
  }

  async claimVoiceMinutes(owner, minutes, dailyLimit) {
    const day = new Date().toISOString().slice(0, 10);
    await this.sql(`INSERT INTO voice_minutes(user_id,utc_date) VALUES($1,$2)
      ON CONFLICT(user_id,utc_date) DO NOTHING`, [owner, day]);
    const rows = await this.sql(`UPDATE voice_minutes SET reserved_minutes=reserved_minutes+$3
      WHERE user_id=$1 AND utc_date=$2 AND reserved_minutes+used_minutes+$3<=$4 RETURNING utc_date`,
    [owner, day, minutes, dailyLimit]);
    return rows.length ? day : null;
  }

  async releaseVoiceMinutes(owner, day, minutes) {
    await this.sql(`UPDATE voice_minutes SET reserved_minutes=reserved_minutes-$3
      WHERE user_id=$1 AND utc_date=$2`, [owner, day, minutes]);
  }

  async bindVoiceCall(owner, interviewId, callId, agentId, reservationId, minutes, day) {
    return (await this.sql(`INSERT INTO voice_calls(id,user_id,interview_id,provider_call_id,agent_id,
      spend_reservation_id,reserved_minutes,utc_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *`, [id(), owner, interviewId, callId, agentId, reservationId, minutes, day]))[0];
  }

  async voiceCall(callId) {
    return (await this.sql('SELECT * FROM voice_calls WHERE provider_call_id=$1', [callId]))[0] ?? null;
  }

  async ownerVoiceCall(owner, interviewId) {
    return (await this.sql('SELECT * FROM voice_calls WHERE user_id=$1 AND interview_id=$2',
      [owner, interviewId]))[0] ?? null;
  }

  async receipt(callId, eventType, payloadHash) {
    const rows = await this.sql(`INSERT INTO voice_webhook_receipts(id,voice_call_id,event_type,payload_hash)
      SELECT $1,id,$3,$4 FROM voice_calls WHERE provider_call_id=$2
      ON CONFLICT(voice_call_id,event_type,payload_hash) DO NOTHING RETURNING id`,
    [id(), callId, eventType, payloadHash]);
    return rows.length > 0;
  }

  async settleVoiceCall(call, durationSeconds, actualMicros) {
    const rows = await this.sql(`WITH ended AS (
      UPDATE voice_calls SET duration_seconds=$3,ended_at=now(),status='ended'
      WHERE id=$1 AND user_id=$2 AND duration_seconds IS NULL
      RETURNING user_id,utc_date,reserved_minutes
    ) UPDATE voice_minutes m SET reserved_minutes=m.reserved_minutes-e.reserved_minutes,
      used_minutes=m.used_minutes+$4 FROM ended e
      WHERE m.user_id=e.user_id AND m.utc_date=e.utc_date RETURNING m.user_id`,
    [call.id, call.user_id, durationSeconds, Math.ceil(durationSeconds / 60)]);
    await this.settle(call.spend_reservation_id, actualMicros);
    return rows.length > 0;
  }

  async claimVoiceTranscript(call) {
    const rows = await this.sql(`UPDATE voice_calls SET transcript_revision=1,status='transcript_ready'
      WHERE id=$1 AND user_id=$2 AND transcript_revision=0 RETURNING id`, [call.id, call.user_id]);
    return rows.length > 0;
  }

  async resetVoiceTranscript(call) {
    await this.sql(`UPDATE voice_calls SET transcript_revision=0,status='ended'
      WHERE id=$1 AND user_id=$2 AND transcript_revision=1`, [call.id, call.user_id]);
  }

  async pendingVoiceJob(owner, interviewId) {
    await this.expireStaleJobs(owner);
    return (await this.sql(`SELECT id FROM model_jobs WHERE user_id=$1 AND kind='voice_finish'
      AND status='queued' AND input_json->>'interviewId'=$2 ORDER BY created_at DESC LIMIT 1`,
    [owner, interviewId]))[0] ?? null;
  }

  async latestVoiceJob(owner, interviewId) {
    await this.expireStaleJobs(owner);
    return (await this.sql(`SELECT id,kind,status,error_code FROM model_jobs WHERE user_id=$1
      AND kind='voice_finish' AND input_json->>'interviewId'=$2
      ORDER BY created_at DESC LIMIT 1`, [owner, interviewId]))[0] ?? null;
  }

  async replaceVoiceTurns(call, turns) {
    await this.sql('DELETE FROM interview_turns WHERE user_id=$1 AND interview_id=$2',
      [call.user_id, call.interview_id]);
    for (let sequence = 0; sequence < turns.length; sequence += 1) {
      await this.sql(`INSERT INTO interview_turns(id,user_id,interview_id,sequence,speaker,text)
        VALUES($1,$2,$3,$4,$5,$6)`,
      [id(), call.user_id, call.interview_id, sequence, turns[sequence].speaker, turns[sequence].text]);
    }
    await this.endInterview(call.user_id, call.interview_id);
  }

  async correctVoiceTurn(owner, interviewId, turnId, text) {
    const call = await this.ownerVoiceCall(owner, interviewId);
    if (!call || !call.transcript_revision) return null;
    const rows = await this.sql(`SELECT * FROM interview_turns WHERE user_id=$1 AND interview_id=$2
      AND id=$3 AND speaker='candidate'`, [owner, interviewId, turnId]);
    const turn = rows[0];
    if (!turn) return null;
    await this.sql(`INSERT INTO voice_transcript_edits(id,user_id,voice_call_id,turn_id,previous_text,corrected_text)
      VALUES($1,$2,$3,$4,$5,$6)`, [id(), owner, call.id, turnId, turn.text, text]);
    await this.sql('UPDATE interview_turns SET text=$4 WHERE user_id=$1 AND interview_id=$2 AND id=$3',
      [owner, interviewId, turnId, text]);
    await this.sql(`UPDATE voice_calls SET transcript_revision=transcript_revision+1
      WHERE id=$1 AND user_id=$2`, [call.id, owner]);
    await this.sql(`UPDATE artifacts SET status='invalidated' WHERE user_id=$1 AND interview_id=$2`,
      [owner, interviewId]);
    await this.sql('DELETE FROM debriefs WHERE user_id=$1 AND interview_id=$2', [owner, interviewId]);
    return await this.createJob(owner, 'voice_finish', { interviewId });
  }

  async interview(owner, interviewId) {
    return (await this.sql('SELECT * FROM interviews WHERE user_id=$1 AND id=$2', [owner, interviewId]))[0] ?? null;
  }

  async turns(owner, interviewId) {
    return this.sql(`SELECT * FROM interview_turns WHERE user_id=$1 AND interview_id=$2
      ORDER BY sequence`, [owner, interviewId]);
  }

  async addTurn(owner, interviewId, speaker, text) {
    const rows = await this.turns(owner, interviewId);
    return (await this.sql(`INSERT INTO interview_turns(id,user_id,interview_id,sequence,speaker,text)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [id(), owner, interviewId, rows.length, speaker, text]))[0];
  }

  async endInterview(owner, interviewId) {
    await this.sql(`UPDATE interviews SET status='ended',ended_at=now() WHERE user_id=$1 AND id=$2`,
      [owner, interviewId]);
  }

  async saveDebrief(owner, interview, result, artifact) {
    const artifactId = id();
    await this.sql(`INSERT INTO artifacts(id,user_id,workspace_id,interview_id,kind,content_json,status,model_id)
      VALUES($1,$2,$3,$4,'rewrite',$5::jsonb,$6,$7)`,
    [artifactId, owner, interview.workspace_id, interview.id, JSON.stringify(artifact),
      artifact.ready ? 'validated' : 'draft', result.modelId ?? null]);
    for (let i = 0; i < artifact.claims.length; i += 1) {
      const claim = artifact.claims[i];
      const claimId = id();
      await this.sql(`INSERT INTO artifact_claims(id,user_id,artifact_id,clause_index,clause_text,
        atomic_claim_json,validation_status,failure_reason) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
      [claimId, owner, artifactId, i, claim.text, JSON.stringify(claim),
        claim.valid ? 'valid' : 'invalid', claim.reason ?? null]);
      for (const factId of claim.factIds ?? []) {
        if (await this.fact(owner, factId)) await this.sql(`INSERT INTO artifact_claim_facts(id,user_id,claim_id,fact_id)
          VALUES($1,$2,$3,$4)`, [id(), owner, claimId, factId]);
      }
    }
    return (await this.sql(`INSERT INTO debriefs(id,user_id,interview_id,content_scores_json,
      delivery_scores_json,unassessed_json,feedback_json,unsupported_claims_json,rewrite_artifact_id,fact_gate_json,input_hash,fact_gate_unavailable)
      VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10::jsonb,$11,$12) RETURNING *`,
    [id(), owner, interview.id, JSON.stringify(result.contentScores), JSON.stringify(result.deliveryScores),
      JSON.stringify(result.unassessed), JSON.stringify(result.feedback),
      JSON.stringify(result.unsupportedClaims), artifactId, JSON.stringify(result.factGate ?? []), result.inputHash ?? null,
      result.factGateUnavailable ?? false]))[0];
  }

  async saveFactGateDecision(owner, interviewId, item, choice, proposalFactId = null, note = null) {
    return (await this.sql(`INSERT INTO fact_gate_decisions(id,user_id,interview_id,lane,answer_quote,choice,
      proposal_fact_id,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(user_id,interview_id,lane,answer_quote) DO NOTHING RETURNING *`,
    [id(), owner, interviewId, item.lane, item.answerQuote, choice, proposalFactId, note]))[0];
  }

  async factGateDecision(owner, interviewId, item) {
    return (await this.sql(`SELECT * FROM fact_gate_decisions WHERE user_id=$1 AND interview_id=$2
      AND lane=$3 AND answer_quote=$4`, [owner, interviewId, item.lane, item.answerQuote]))[0] ?? null;
  }

  async debrief(owner, interviewId) {
    return (await this.sql(`SELECT d.*,a.content_json AS rewrite,a.status AS rewrite_status
      FROM debriefs d JOIN artifacts a ON a.user_id=d.user_id AND a.id=d.rewrite_artifact_id
      WHERE d.user_id=$1 AND d.interview_id=$2 ORDER BY d.created_at DESC LIMIT 1`,
    [owner, interviewId]))[0] ?? null;
  }

  // The latest finished debrief in this workspace from an interview that started earlier.
  async previousDebrief(owner, workspaceId, interviewId) {
    return (await this.sql(`SELECT d.feedback_json FROM debriefs d
      JOIN interviews i ON i.user_id=d.user_id AND i.id=d.interview_id
      WHERE d.user_id=$1 AND i.workspace_id=$2 AND i.id<>$3
      AND i.started_at < (SELECT started_at FROM interviews WHERE user_id=$1 AND id=$3)
      ORDER BY i.started_at DESC, d.created_at DESC LIMIT 1`, [owner, workspaceId, interviewId]))[0]?.feedback_json ?? null;
  }

  async replaceRewriteSlots(owner, interviewId, labels) {
    await this.sql('DELETE FROM rewrite_slots WHERE user_id=$1 AND interview_id=$2', [owner, interviewId]);
    for (const label of labels) await this.sql(`INSERT INTO rewrite_slots(id,user_id,interview_id,label)
      VALUES($1,$2,$3,$4)`, [id(), owner, interviewId, label]);
    return this.rewriteSlots(owner, interviewId);
  }

  async rewriteSlots(owner, interviewId) {
    return this.sql('SELECT * FROM rewrite_slots WHERE user_id=$1 AND interview_id=$2 ORDER BY created_at,id',
      [owner, interviewId]);
  }

  async rewriteSlot(owner, slotId) {
    return (await this.sql('SELECT * FROM rewrite_slots WHERE user_id=$1 AND id=$2', [owner, slotId]))[0] ?? null;
  }

  async startDig(owner, workspaceId, competency) {
    return (await this.sql(`INSERT INTO story_digs(id,user_id,workspace_id,competency)
      VALUES($1,$2,$3,$4) RETURNING *`, [id(), owner, workspaceId, competency]))[0];
  }

  async dig(owner, digId) {
    return (await this.sql('SELECT * FROM story_digs WHERE user_id=$1 AND id=$2', [owner, digId]))[0] ?? null;
  }

  async reflectDig(owner, digId, scene, reflection) {
    return (await this.sql(`UPDATE story_digs SET scene_text=$3,reflection=$4,status='awaiting_confirmation'
      WHERE user_id=$1 AND id=$2 AND status='started' RETURNING *`,
    [owner, digId, scene, reflection]))[0] ?? null;
  }

  async confirmDig(owner, digId, correctedScene) {
    return (await this.sql(`UPDATE story_digs SET scene_text=$3,status='confirmed',confirmed_at=now()
      WHERE user_id=$1 AND id=$2 AND status='awaiting_confirmation' RETURNING *`,
    [owner, digId, correctedScene]))[0] ?? null;
  }

  async resolveRewriteSlot(owner, slotId, state, proposalFactId = null, reason = null) {
    return (await this.sql(`UPDATE rewrite_slots SET state=$3,proposal_fact_id=$4,reason=$5,resolved_at=now()
      WHERE user_id=$1 AND id=$2 AND state='pending' RETURNING *`,
    [owner, slotId, state, proposalFactId, reason]))[0] ?? null;
  }

  async reserve(bucket, micros, capMicros, key, now = new Date(), owner = null, userCapMicros = null, ttlMs = 15 * 60_000) {
    if (![micros, capMicros, ttlMs].every((value) => Number.isSafeInteger(value) && value > 0) ||
        (userCapMicros !== null && (!Number.isSafeInteger(userCapMicros) || userCapMicros <= 0))) {
      throw new Error('Invalid spend reservation');
    }
    return this.withResourceLock((repo) => repo.reserveLocked(bucket, micros, capMicros, key, now, owner, userCapMicros, ttlMs));
  }

  async reserveLocked(bucket, micros, capMicros, key, now, owner, userCapMicros, ttlMs) {
    const day = now.toISOString().slice(0, 10);
    const existing = (await this.sql('SELECT id FROM spend_reservations WHERE idempotency_key=$1', [key]))[0];
    if (existing) return existing.id;
    // A lost response can still be billed. Keep uncertain holds charged for
    // their UTC day until usage or a definitive no-charge result settles them.
    // The next day's independent bucket restores capacity without overspend.
    await this.sql(`INSERT INTO spend_days(utc_date,cap_micros) VALUES($1,$2)
      ON CONFLICT(utc_date) DO UPDATE SET cap_micros=EXCLUDED.cap_micros`, [day, capMicros]);
    if (owner && userCapMicros !== null) {
      const userTaken = await this.sql(`SELECT coalesce(sum(CASE WHEN state='settled' THEN actual_micros ELSE estimated_micros END),0)::bigint AS micros
        FROM spend_reservations WHERE user_id=$1 AND utc_date=$2 AND state IN ('reserved','settled')`, [owner, day]);
      if (Number(userTaken[0].micros) + micros > userCapMicros) return null;
    }
    const rows = await this.sql(`WITH taken AS (
      UPDATE spend_days SET reserved_micros=reserved_micros+$2
      WHERE utc_date=$1 AND reserved_micros+settled_micros+$2<=cap_micros
      RETURNING utc_date
    ) INSERT INTO spend_reservations(id,utc_date,bucket,estimated_micros,idempotency_key,expires_at,user_id)
      SELECT $3,utc_date,$4,$2,$5,$6::timestamptz+($8::bigint * interval '1 millisecond'),$7::uuid FROM taken
      ON CONFLICT(idempotency_key) DO NOTHING RETURNING id`,
    [day, micros, id(), bucket, key, now, owner, ttlMs]);
    return rows[0]?.id ?? null;
  }

  async settle(reservationId, actualMicros) {
    await this.sql(`WITH moved AS (
      UPDATE spend_reservations SET actual_micros=$2,state='settled'
      WHERE id=$1 AND state='reserved' RETURNING utc_date,estimated_micros
    ) UPDATE spend_days d SET reserved_micros=d.reserved_micros-m.estimated_micros,
      settled_micros=d.settled_micros+$2 FROM moved m WHERE d.utc_date=m.utc_date`,
    [reservationId, actualMicros]);
  }

  async deleteAccount(owner) {
    const tables = [
      'spend_reservations',
      'fact_conflict_reviews',
      'prep_pack_sections', 'prep_packs', 'coach_notes', 'immersions',
      'voice_transcript_edits', 'voice_calls', 'voice_minutes',
      'fact_gate_decisions', 'real_interviews', 'drill_reviews', 'drill_cards', 'story_digs', 'rewrite_slots', 'model_jobs', 'writing_profiles', 'upload_chunks', 'uploads', 'debriefs', 'artifact_claim_facts', 'artifact_claims', 'artifacts',
      'interview_turns', 'interviews', 'requirement_match_facts', 'requirement_matches', 'requirements', 'fact_events', 'fact_evidence',
      'facts', 'source_spans', 'job_hunt_history', 'workspaces', 'sources', 'auth_sessions',
    ];
    for (const table of tables) {
      // Catching undefined_table inside a transaction leaves that transaction aborted.
      // Check optional historical tables before issuing the destructive statement.
      if (!(await this.sql('SELECT to_regclass($1) AS name', [table]))[0]?.name) continue;
      await this.sql(`DELETE FROM ${table} WHERE user_id=$1`, [owner]);
    }
    await this.sql('DELETE FROM users WHERE id=$1', [owner]);
  }

  async purgeGenerated(owner) {
    await this.sql('DELETE FROM immersions WHERE user_id=$1', [owner]);
    await this.sql('DELETE FROM fact_gate_decisions WHERE user_id=$1', [owner]);
    await this.sql('DELETE FROM rewrite_slots WHERE user_id=$1', [owner]);
    await this.sql('DELETE FROM debriefs WHERE user_id=$1', [owner]);
    await this.sql('DELETE FROM artifact_claim_facts WHERE user_id=$1', [owner]);
    await this.sql('DELETE FROM artifact_claims WHERE user_id=$1', [owner]);
    await this.sql('DELETE FROM artifacts WHERE user_id=$1', [owner]);
  }

  async clearDerivedText(owner) {
    // These tables don't retain fact/source provenance. Clearing all owner-scoped derived
    // payloads is deliberately broader than deletion so source wording cannot survive.
    for (const statement of [
      `UPDATE model_jobs SET input_json='{}'::jsonb,result_json=NULL,status='failed',finished_at=now(),error_code='source_deleted' WHERE user_id=$1`,
      `UPDATE prep_pack_sections SET content_json=NULL,status='stale',error_code='source_deleted',updated_at=now() WHERE user_id=$1`,
      `UPDATE story_digs SET scene_text=NULL,reflection=NULL,status='started',confirmed_at=NULL WHERE user_id=$1`,
    ]) {
      const table = statement.split(/\s+/)[1]; // fixed statements above, never user input
      if (!(await this.sql('SELECT to_regclass($1) AS name', [table]))[0]?.name) continue;
      await this.sql(statement, [owner]);
    }
  }

  async deleteFact(owner, factId) {
    return this.withResourceLock((repo) => repo.deleteFactLocked(owner, factId));
  }

  async deleteFactLocked(owner, factId) {
    await this.clearDerivedText(owner);
    await this.purgeGenerated(owner);
    const ids = await this.sql(`WITH RECURSIVE descendants AS (
      SELECT id,0 AS depth FROM facts WHERE user_id=$1 AND id=$2
      UNION ALL SELECT f.id,d.depth+1 FROM facts f JOIN descendants d
      ON f.user_id=$1 AND f.supersedes_fact_id=d.id
    ) SELECT id FROM descendants ORDER BY depth DESC`, [owner, factId]);
    for (const { id: current } of ids) {
      await this.sql("DELETE FROM drill_reviews WHERE user_id=$1 AND card_id IN (SELECT id FROM drill_cards WHERE user_id=$1 AND fact_ids ? $2)", [owner, current]);
      await this.sql("DELETE FROM drill_cards WHERE user_id=$1 AND fact_ids ? $2", [owner, current]);
      await this.sql('DELETE FROM fact_events WHERE user_id=$1 AND (fact_id=$2 OR replacement_fact_id=$2)', [owner, current]);
      await this.sql('DELETE FROM requirement_match_facts WHERE user_id=$1 AND fact_id=$2', [owner, current]);
      await this.sql('DELETE FROM fact_evidence WHERE user_id=$1 AND fact_id=$2', [owner, current]);
      await this.sql('DELETE FROM facts WHERE user_id=$1 AND id=$2', [owner, current]);
    }
    return ids.length;
  }

  async deleteSource(owner, sourceId) {
    return this.withResourceLock((repo) => repo.deleteSourceLocked(owner, sourceId));
  }

  async deleteSourceLocked(owner, sourceId) {
    const source = await this.source(owner, sourceId);
    if (!source) return false;
    const captures = await this.sql('SELECT stumped_json FROM real_interviews WHERE user_id=$1 AND source_id=$2',
      [owner, sourceId]);
    for (const capture of captures) for (const question of capture.stumped_json) {
      const cue = `Recover from the real question: ${question}`;
      await this.sql('DELETE FROM drill_reviews WHERE user_id=$1 AND card_id IN (SELECT id FROM drill_cards WHERE user_id=$1 AND cue=$2)',
        [owner, cue]);
      await this.sql('DELETE FROM drill_cards WHERE user_id=$1 AND cue=$2', [owner, cue]);
    }
    await this.clearDerivedText(owner);
    await this.purgeGenerated(owner);
    await this.sql('DELETE FROM upload_chunks WHERE user_id=$1 AND upload_id IN (SELECT id FROM uploads WHERE user_id=$1 AND source_id=$2)', [owner, sourceId]);
    await this.sql('DELETE FROM uploads WHERE user_id=$1 AND source_id=$2', [owner, sourceId]);
    const linkedFacts = await this.sql(`SELECT DISTINCT e.fact_id FROM fact_evidence e
      JOIN source_spans s ON s.user_id=e.user_id AND s.id=e.span_id
      WHERE e.user_id=$1 AND s.source_id=$2`, [owner, sourceId]);
    for (const row of linkedFacts) await this.deleteFact(owner, row.fact_id);
    const workspaces = await this.sql('SELECT id FROM workspaces WHERE user_id=$1 AND jd_source_id=$2', [owner, sourceId]);
    for (const workspace of workspaces) {
      const interviews = await this.sql('SELECT id FROM interviews WHERE user_id=$1 AND workspace_id=$2', [owner, workspace.id]);
      for (const interview of interviews) {
        await this.sql('DELETE FROM debriefs WHERE user_id=$1 AND interview_id=$2', [owner, interview.id]);
        await this.sql('DELETE FROM interview_turns WHERE user_id=$1 AND interview_id=$2', [owner, interview.id]);
      }
      const artifacts = await this.sql('SELECT id FROM artifacts WHERE user_id=$1 AND workspace_id=$2', [owner, workspace.id]);
      for (const artifact of artifacts) {
        await this.sql(`DELETE FROM artifact_claim_facts WHERE user_id=$1 AND claim_id IN
          (SELECT id FROM artifact_claims WHERE user_id=$1 AND artifact_id=$2)`, [owner, artifact.id]);
        await this.sql('DELETE FROM artifact_claims WHERE user_id=$1 AND artifact_id=$2', [owner, artifact.id]);
        await this.sql('DELETE FROM artifacts WHERE user_id=$1 AND id=$2', [owner, artifact.id]);
      }
      await this.sql('DELETE FROM interviews WHERE user_id=$1 AND workspace_id=$2', [owner, workspace.id]);
      const remaining = await this.sql('SELECT id FROM facts WHERE user_id=$1 AND workspace_id=$2', [owner, workspace.id]);
      for (const fact of remaining) await this.deleteFact(owner, fact.id);
      await this.sql('DELETE FROM workspaces WHERE user_id=$1 AND id=$2', [owner, workspace.id]);
    }
    await this.sql('DELETE FROM source_spans WHERE user_id=$1 AND source_id=$2', [owner, sourceId]);
    await this.sql('DELETE FROM sources WHERE user_id=$1 AND id=$2', [owner, sourceId]);
    return true;
  }

  // Guest voice: bookkeeping only, never transcript content.
  async claimGuestVoicePool(minutes, dailyLimit) {
    if (!Number.isFinite(minutes) || !Number.isFinite(dailyLimit) || minutes <= 0 || dailyLimit <= 0 || minutes > dailyLimit) return null;
    const day = new Date().toISOString().slice(0, 10);
    const rows = await this.sql(`INSERT INTO guest_voice_pool(utc_date,reserved_minutes) VALUES($1,$2)
      ON CONFLICT (utc_date) DO UPDATE SET reserved_minutes=guest_voice_pool.reserved_minutes+$2
      WHERE guest_voice_pool.reserved_minutes+$2 <= $3 RETURNING utc_date`, [day, minutes, dailyLimit]);
    if (!rows.length && minutes > dailyLimit) return null;
    return rows.length ? day : null;
  }

  async releaseGuestVoicePool(day, minutes) {
    await this.sql('UPDATE guest_voice_pool SET reserved_minutes=GREATEST(0,reserved_minutes-$2) WHERE utc_date=$1', [day, minutes]);
  }

  async bindGuestVoiceCall(callId, tokenHash, reservationId, minutes, day) {
    await this.sql(`INSERT INTO guest_voice_calls(provider_call_id,token_hash,spend_reservation_id,reserved_minutes,utc_date)
      VALUES($1,$2,$3,$4,$5)`, [callId, tokenHash, reservationId, minutes, day]);
  }

  async guestVoiceCall(callId) {
    return (await this.sql('SELECT * FROM guest_voice_calls WHERE provider_call_id=$1', [callId]))[0] ?? null;
  }

  // Settles once. Returns true only for the first settlement of this call.
  async settleGuestVoiceCall(call, seconds, micros) {
    const rows = await this.sql(`UPDATE guest_voice_calls SET status='settled', duration_seconds=$2
      WHERE provider_call_id=$1 AND status='active' RETURNING provider_call_id`, [call.provider_call_id, seconds]);
    if (!rows.length) return false;
    await this.settle(call.spend_reservation_id, micros);
    const usedMinutes = Math.min(call.reserved_minutes, Math.ceil(seconds / 60));
    await this.releaseGuestVoicePool(call.utc_date, call.reserved_minutes - usedMinutes);
    return true;
  }

  async abuse(bucket, subject, limit, windowMinutes = 15) {
    const start = new Date(Math.floor(Date.now() / (windowMinutes * 60000)) * windowMinutes * 60000);
    const rows = await this.sql(`INSERT INTO abuse_windows(bucket,subject_hmac,window_start,expires_at)
      VALUES($1,$2,$3,$4) ON CONFLICT(bucket,subject_hmac,window_start)
      DO UPDATE SET count=abuse_windows.count+1 RETURNING count`,
    [bucket, subject, start, new Date(start.getTime() + windowMinutes * 60000)]);
    return rows[0].count <= limit;
  }
}
