import { createHmac, timingSafeEqual, randomBytes, randomUUID } from 'node:crypto';
import { CoachService, InputError } from './service.js';
import { hash, perUserDailyCapMicros } from './repository.js';
import { PLAIN_INTERVIEWER_INSTRUCTION, plainQuestionPlan } from './plain.js';
import { retellConnection } from './retell-connection.js';

// "Plain English interviewer" (off unless the caller asks). Retell's per-call overrides can't
// replace the agent's prompt, so the instruction rides in a dynamic variable the prompt
// already reads ({{mode}}), and the planned questions go over already translated.
// Nothing about the Retell agent itself changes.
export async function applyPlainInterviewer(variables, plan, model) {
  return { ...variables,
    mode: `${variables.mode}. ${PLAIN_INTERVIEWER_INSTRUCTION}`,
    question_plan: (await plainQuestionPlan(plan, model)).join('\n') };
}

// Safety caps: signed-in 30 min per call, 90 min per day.
const MAX_MINUTES = 30;
const COST_MICROS_PER_MINUTE = 200_000;

export function voiceConfigured(env) {
  return Boolean(env.RETELL_API_KEY && env.RETELL_AGENT_ID && env.RETELL_WEBHOOK_KEY);
}

function positiveNumber(value, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export async function startVoice({ repo, model, env, fetchImpl = fetch, plainModel = null }, owner, username, input) {
  if (!voiceConfigured(env)) throw new InputError('Voice practice is unavailable. Use text practice.', 503);
  const minutes = positiveNumber(env.VOICE_MAX_MINUTES, MAX_MINUTES);
  const limit = positiveNumber(env.VOICE_DAILY_MINUTES_LIMIT, 90);
  const cap = positiveNumber(env.DAILY_USD_CAP, 15);
  if (!minutes || !limit || !cap || !Number.isInteger(minutes) || !Number.isInteger(limit)) {
    throw new InputError('Voice spend limits are unavailable. Use text practice.', 503);
  }
  const workspace = await repo.workspace(owner, input.workspaceId);
  if (!workspace) throw new InputError('Workspace not found', 404);
  const micros = minutes * COST_MICROS_PER_MINUTE;
  const day = await repo.claimVoiceMinutes(owner, minutes, limit);
  if (!day) throw new InputError('Today’s voice minutes are used. Use text practice.', 503);
  let reservation;
  let released = false;
  let providerMayHaveCreated = false;
  try {
    const capMicros = Math.floor(cap * 1e6);
    reservation = await repo.reserve('voice', micros, capMicros, randomUUID(), new Date(), owner,
      perUserDailyCapMicros(capMicros, micros));
    if (!reservation) throw new InputError('Daily spend cap reached. Use text practice.', 503);
    const service = new CoachService(repo, model, owner);
    const started = await service.start(owner, input.workspaceId, input.persona,
      input.difficulty ?? 2, input.practiceMode ?? 'mock');
    const requirements = await repo.requirements(owner, input.workspaceId);
    const confirmedFacts = (await repo.facts(owner, input.workspaceId)).filter((fact) =>
      fact.domain === 'candidate' && fact.review_state === 'accepted' && fact.lifecycle === 'active')
      .map((fact) => fact.verbatim_quote || fact.display_text).filter(Boolean).slice(0, 12);
    let variables = {
      persona: started.interview.persona === 'recruiter' ? 'recruiter_screen' : started.interview.persona,
      role_title: workspace.role_title || workspace.label || 'this role',
      company_name: workspace.company_name || 'the company in the posting',
      job_summary: requirements.map((item) => `${item.type}: ${item.text}`).join('\n').slice(0, 12000),
      question_plan: started.interview.plan_json.join('\n'),
      evidence_gaps: requirements.filter((item) => item.category === 'none')
        .map((item) => item.competency || item.text).join('\n').slice(0, 5000),
      depth_level: String(started.interview.difficulty),
      mode: started.interview.practice_mode,
      candidate_first_name: String(username).split(/[._\s-]/)[0].slice(0, 60),
      confirmed_facts: confirmedFacts.join('\n').slice(0, 6000),
      coach_notes: (await repo.coachNotes(owner, input.workspaceId)).filter((note) => note.active)
        .slice(0, 8).map((note) => note.text).join('\n') || 'None.',
    };
    if (input.plainEnglish === true) {
      variables = await applyPlainInterviewer(variables, started.interview.plan_json, plainModel);
    }
    const response = await fetchImpl('https://api.retellai.com/v3/create-web-call', {
      method: 'POST', headers: { authorization: `Bearer ${env.RETELL_API_KEY}`,
        'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: env.RETELL_AGENT_ID,
        retell_llm_dynamic_variables: variables, data_storage_setting: 'everything_except_pii',
        data_storage_retention_days: 1,
        agent_override: { agent: { max_call_duration_ms: minutes * 60_000,
          data_storage_setting: 'everything_except_pii', data_storage_retention_days: 1 } },
        metadata: { interview_id: started.interview.id } }),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) {
      await repo.settle(reservation, 0);
      await repo.releaseVoiceMinutes(owner, day, minutes);
      released = true;
      throw new InputError('Could not start the voice call. Use text practice.', 503);
    }
    providerMayHaveCreated = true;
    const call = await response.json();
    let connection;
    try { connection = retellConnection(call); }
    catch { throw new InputError('Voice setup returned an incomplete call. Use text practice.', 503); }
    await repo.bindVoiceCall(owner, started.interview.id, call.call_id, env.RETELL_AGENT_ID,
      reservation, minutes, day);
    await repo.markVoiceInterview(owner, started.interview.id);
    return { interviewId: started.interview.id, ...connection, maxMinutes: minutes };
  } catch (error) {
    // A create timeout or network failure gives no usable call credentials. Release our local
    // cap so one uncertain Retell request cannot block the rest of today's practice.
    if (!released && !providerMayHaveCreated) {
      if (reservation) await repo.settle(reservation, 0);
      await repo.releaseVoiceMinutes(owner, day, minutes);
    }
    throw error;
  }
}

export function verifyRetellSignature(raw, header, key, now = Date.now()) {
  if (!key || !header) return false;
  const parts = Object.fromEntries(header.split(',').map((part) => part.trim().split('=')));
  const timestamp = parts.v;
  const digest = parts.d;
  if (!/^\d{13}$/.test(timestamp ?? '') || !/^[a-f0-9]{64}$/i.test(digest ?? '') ||
      Math.abs(now - Number(timestamp)) > 300_000) return false;
  const expected = createHmac('sha256', key).update(raw).update(timestamp).digest();
  return timingSafeEqual(expected, Buffer.from(digest, 'hex'));
}

export function normalizeRetellTurns(data) {
  const list = data.transcript_object ?? data.transcript_with_tool_calls;
  if (Array.isArray(list)) return list.filter((item) =>
    ['agent', 'user'].includes(item?.role) && typeof item.content === 'string' && item.content.trim())
    .slice(0, 200).map((item) => ({ speaker: item.role === 'agent' ? 'interviewer' : 'candidate',
      text: item.content.trim().slice(0, 4000) }));
  if (typeof data.transcript !== 'string') return [];
  return data.transcript.split(/\r?\n/).map((line) => line.match(/^(Agent|User):\s*(.+)$/i))
    .filter(Boolean).map((match) => ({ speaker: match[1].toLowerCase() === 'agent' ? 'interviewer' : 'candidate',
      text: match[2].trim().slice(0, 4000) }));
}

export async function acceptVoiceWebhook({ repo, raw, signature, key, now = Date.now() }) {
  if (!verifyRetellSignature(raw, signature, key, now)) return { status: 401, result: 'invalid_signature' };
  let event;
  try { event = JSON.parse(raw); } catch { return { status: 400, result: 'invalid_json' }; }
  if (!['call_ended', 'call_analyzed'].includes(event.event) || typeof event.call?.call_id !== 'string') {
    return { status: 200, result: 'ignored' };
  }
  if (await settleGuestVoiceFromWebhook(repo, event)) return { status: 200, result: 'guest_settled' };
  const call = await repo.voiceCall(event.call.call_id);
  if (!call) return { status: 200, result: 'unknown_call' };
  const duration = Number(event.call.duration_ms ??
    (Number.isFinite(event.call.end_timestamp) && Number.isFinite(event.call.start_timestamp)
      ? event.call.end_timestamp - event.call.start_timestamp : NaN));
  if (Number.isFinite(duration) && duration >= 0) {
    const seconds = Math.ceil(duration / 1000);
    await repo.settleVoiceCall(call, seconds, Math.ceil(seconds / 60) * COST_MICROS_PER_MINUTE);
  }
  if (!await repo.receipt(call.provider_call_id, event.event, hash(raw)) && call.transcript_revision > 0) {
    const pending = await repo.pendingVoiceJob(call.user_id, call.interview_id);
    return { status: 200, result: 'duplicate', jobId: pending?.id };
  }
  const turns = normalizeRetellTurns(event.call);
  if (!turns.some((turn) => turn.speaker === 'candidate') ||
      turns.reduce((sum, turn) => sum + turn.text.length, 0) > 50000) {
    return { status: 200, result: 'awaiting_transcript' };
  }
  if (!await repo.claimVoiceTranscript(call)) return { status: 200, result: 'already_processed' };
  try {
    await repo.replaceVoiceTurns(call, turns);
    const job = await repo.createJob(call.user_id, 'voice_finish', { interviewId: call.interview_id });
    return { status: 200, result: 'queued', jobId: job.id };
  } catch (error) {
    await repo.resetVoiceTranscript(call);
    throw error;
  }
}


// ---- Guest voice (guests can make a short, capped voice call)
// Caps: 5 minutes per call (also enforced by the guest Retell agent itself), 2 calls per browser
// per day, 60 guest minutes per day across all guests, plus the site-wide spend cap.
// Privacy: the server stores only call id, token hash and spend. The transcript is fetched from
// Retell on demand, handed to this browser's guest state, and never written to the database.
const GUEST_MAX_MINUTES = 5;
const GUEST_CALLS_PER_DAY = 2;

export function guestVoiceLimits(env = {}) {
  return {
    maxMinutes: positiveNumber(env.GUEST_VOICE_MAX_MINUTES, GUEST_MAX_MINUTES),
    callsPerDay: positiveNumber(env.GUEST_VOICE_CALLS_PER_DAY, GUEST_CALLS_PER_DAY),
  };
}

export function guestVoiceConfigured(env) {
  return Boolean(env.RETELL_API_KEY && env.RETELL_GUEST_AGENT_ID);
}

export async function startGuestVoice({ repo, env, fetchImpl = fetch, plainModel = null }, service, subject, input) {
  if (!guestVoiceConfigured(env)) throw new InputError('Voice practice is unavailable. Use text practice.', 503);
  const { maxMinutes: minutes, callsPerDay: perBrowser } = guestVoiceLimits(env);
  const pool = positiveNumber(env.GUEST_VOICE_DAILY_MINUTES, 60);
  const cap = positiveNumber(env.DAILY_USD_CAP, 15);
  if (!minutes || !perBrowser || !pool || !cap) throw new InputError('Voice spend limits are unavailable. Use text practice.', 503);
  const workspace = await service.repo.workspace('guest', input.workspaceId);
  if (!workspace) throw new InputError('Workspace not found', 404);
  if (!await repo.abuse('guest_voice', subject, perBrowser, 24 * 60)) {
    throw new InputError(`Guests get ${perBrowser} voice calls a day. Sign up for more, or keep practicing by text.`, 429);
  }
  const day = await repo.claimGuestVoicePool(minutes, pool);
  if (!day) throw new InputError('Guest voice time is used up for today. Text practice still works.', 503);
  let reservation;
  let released = false;
  let providerMayHaveCreated = false;
  try {
    reservation = await repo.reserve('voice', minutes * COST_MICROS_PER_MINUTE, Math.floor(cap * 1e6), randomUUID());
    if (!reservation) throw new InputError('Daily spend cap reached. Use text practice.', 503);
    const started = await service.start('guest', input.workspaceId, input.persona,
      input.difficulty ?? 2, input.practiceMode ?? 'mock');
    const requirements = await service.repo.requirements('guest', input.workspaceId);
    const confirmedFacts = (await service.repo.facts('guest', input.workspaceId)).filter((fact) =>
      fact.domain === 'candidate' && fact.review_state === 'accepted' && fact.lifecycle === 'active')
      .map((fact) => fact.verbatim_quote || fact.display_text).filter(Boolean).slice(0, 12);
    let variables = {
      persona: started.interview.persona === 'recruiter' ? 'recruiter_screen' : started.interview.persona,
      role_title: workspace.role_title || workspace.label || 'this role',
      company_name: workspace.company_name || 'the company in the posting',
      job_summary: requirements.map((item) => `${item.type}: ${item.text}`).join('\n').slice(0, 6000),
      question_plan: started.interview.plan_json.join('\n'),
      evidence_gaps: requirements.filter((item) => item.category === 'none')
        .map((item) => item.competency || item.text).join('\n').slice(0, 3000),
      depth_level: String(started.interview.difficulty ?? 2),
      mode: started.interview.practice_mode ?? 'mock',
      candidate_first_name: 'there',
      confirmed_facts: confirmedFacts.join('\n').slice(0, 6000),
      coach_notes: 'None.',
    };
    if (input.plainEnglish === true) {
      variables = await applyPlainInterviewer(variables, started.interview.plan_json, plainModel);
    }
    const response = await fetchImpl('https://api.retellai.com/v3/create-web-call', {
      method: 'POST', headers: { authorization: `Bearer ${env.RETELL_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: env.RETELL_GUEST_AGENT_ID, retell_llm_dynamic_variables: variables,
        data_storage_setting: 'everything_except_pii', data_storage_retention_days: 1,
        agent_override: { agent: { max_call_duration_ms: minutes * 60_000 } },
        metadata: { guest: true } }),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) {
      await repo.settle(reservation, 0);
      await repo.releaseGuestVoicePool(day, minutes);
      released = true;
      throw new InputError('Could not start the voice call. Use text practice.', 503);
    }
    providerMayHaveCreated = true;
    const call = await response.json();
    let connection;
    try { connection = retellConnection(call); }
    catch { throw new InputError('Voice setup returned an incomplete call. Use text practice.', 503); }
    const guestToken = randomBytes(24).toString('base64url');
    await repo.bindGuestVoiceCall(call.call_id, hash(guestToken), reservation, minutes, day);
    return { interviewId: started.interview.id, ...connection, guestToken, maxMinutes: minutes };
  } catch (error) {
    if (!released && !providerMayHaveCreated) {
      if (reservation) await repo.settle(reservation, 0);
      await repo.releaseGuestVoicePool(day, minutes);
    }
    throw error;
  }
}

function sameHash(a, b) {
  const left = Buffer.from(String(a)); const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function guestVoiceStatus({ repo, env, fetchImpl = fetch }, service, input) {
  const call = typeof input.callId === 'string' ? await repo.guestVoiceCall(input.callId) : null;
  if (!call || call.expires_at <= new Date() || typeof input.guestToken !== 'string' || !sameHash(call.token_hash, hash(input.guestToken))) {
    throw new InputError('Voice call not found', 404);
  }
  const interview = await service.repo.interview('guest', input.interviewId);
  if (!interview) throw new InputError('Interview not found', 404);
  const response = await fetchImpl(`https://api.retellai.com/v2/get-call/${encodeURIComponent(call.provider_call_id)}`, {
    headers: { authorization: `Bearer ${env.RETELL_API_KEY}` }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new InputError('Could not read the call yet. Try again in a moment.', 503);
  const data = await response.json();
  if (!['ended', 'error', 'not_connected'].includes(data.call_status)) return { status: 'active' };
  const duration = Number(data.duration_ms ?? (data.end_timestamp - data.start_timestamp));
  const seconds = Number.isFinite(duration) && duration >= 0 ? Math.ceil(duration / 1000) : call.reserved_minutes * 60;
  await repo.settleGuestVoiceCall(call, seconds, Math.ceil(seconds / 60) * COST_MICROS_PER_MINUTE);
  const turns = normalizeRetellTurns(data);
  if (!turns.some((turn) => turn.speaker === 'candidate')) return { status: 'ended', turns: [], report: null };
  // Replace this interview's turns in the guest's own browser state with the call transcript.
  service.repo.state.turns = service.repo.state.turns.filter((turn) => turn.interview_id !== interview.id);
  for (const turn of turns.slice(0, 120)) await service.repo.addTurn('guest', interview.id, turn.speaker, turn.text.slice(0, 1000));
  await service.repo.endInterview('guest', interview.id);
  const report = await service.debrief('guest', interview.id);
  return { status: 'ended', turns: await service.repo.turns('guest', interview.id), report };
}

export async function settleGuestVoiceFromWebhook(repo, event) {
  const call = await repo.guestVoiceCall(event.call.call_id);
  if (!call) return false;
  const duration = Number(event.call.duration_ms ?? (event.call.end_timestamp - event.call.start_timestamp));
  if (Number.isFinite(duration) && duration >= 0) {
    const seconds = Math.ceil(duration / 1000);
    await repo.settleGuestVoiceCall(call, seconds, Math.ceil(seconds / 60) * COST_MICROS_PER_MINUTE);
  }
  return true;
}
