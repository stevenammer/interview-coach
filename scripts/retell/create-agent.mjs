#!/usr/bin/env node
// Creates (or updates) the Interview Coach Retell LLM and voice agent from
// docs/retell/interviewer_prompt.md. Idempotent: IDs are kept in
// scripts/retell/agent.json and reused. Nothing here is billed until a call happens.
//
//   RETELL_API_KEY=... node scripts/retell/create-agent.mjs [--webhook https://<site>/.netlify/functions/retell-webhook]
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const API = 'https://api.retellai.com';
const key = process.env.RETELL_API_KEY;
if (!key) { console.error('RETELL_API_KEY is required'); process.exit(1); }
const webhookArg = process.argv.indexOf('--webhook');
const webhookUrl = webhookArg > -1 ? process.argv[webhookArg + 1] : undefined;
if (webhookArg > -1) {
  let parsed;
  try { parsed = new URL(webhookUrl); } catch { throw new Error('--webhook requires a valid HTTPS URL'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('--webhook requires an HTTPS URL without credentials');
}
const variants = [
  { key: 'agent_id', name: 'Interview Coach - Practice Interviewer', maxMinutes: Number(process.env.SIGNED_IN_MAX_CALL_MINUTES || 30) },
  { key: 'guest_agent_id', name: 'Interview Coach - Guest Practice Interviewer', maxMinutes: Number(process.env.GUEST_MAX_CALL_MINUTES || 5) },
];
if (variants.some(({ maxMinutes }) => maxMinutes <= 0 || !Number.isSafeInteger(maxMinutes) || !Number.isSafeInteger(maxMinutes * 60_000))) {
  throw new Error('Voice minute limits must be positive safe integers');
}
const statePath = new URL('./agent.json', import.meta.url);
const state = existsSync(statePath) ? JSON.parse(await readFile(statePath, 'utf8')) : {};
const prompt = await readFile(new URL('../../docs/retell/interviewer_prompt.md', import.meta.url), 'utf8');

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method, headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(12000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return text ? JSON.parse(text) : {};
}

const llmBody = {
  model: process.env.RETELL_LLM_MODEL || 'gpt-4.1',
  model_temperature: 0.4,
  general_prompt: prompt,
  start_speaker: 'agent',
  default_dynamic_variables: {
    persona: 'hiring_manager', role_title: 'the role', company_name: 'the company',
    job_summary: 'Not provided.', question_plan: 'Ask about their most relevant experience.',
    evidence_gaps: 'None listed.', confirmed_facts: 'None confirmed yet.', coach_notes: 'None.', depth_level: '2', mode: 'mock', candidate_first_name: 'there',
  },
};
const llm = state.llm_id
  ? await call('PATCH', `/update-retell-llm/${state.llm_id}`, llmBody)
  : await call('POST', '/create-retell-llm', llmBody);
state.llm_id = llm.llm_id;

// Two agents share one LLM. The call-length cap is enforced by Retell itself, so a
// client can't talk past it: guests 5 minutes, signed-in users 30 minutes.
const baseAgent = {
  response_engine: { type: 'retell-llm', llm_id: state.llm_id },
  voice_id: '11labs-Kate',
  language: 'en-US',
  // Director-level answers need thinking time: reply less eagerly than a sales guest.
  responsiveness: 0.5,
  interruption_sensitivity: 0.4,
  // User feedback: the "mhm" backchannels felt unnatural.
  enable_backchannel: false,
  denoising_mode: 'noise-cancellation',
  // Retell can retain scrubbed transcripts AND recordings in this mode.
  // Review PII categories and retention in Retell before using real interview audio.
  data_storage_setting: 'everything_except_pii',
  data_storage_retention_days: 1,
  opt_in_signed_url: true,
  end_call_after_silence_ms: 90_000,
  ...(webhookUrl ? { webhook_url: webhookUrl } : {}),
};
const results = {};
for (const variant of variants) {
  const body = { ...baseAgent, agent_name: variant.name, max_call_duration_ms: variant.maxMinutes * 60 * 1000 };
  const agent = state[variant.key]
    ? await call('PATCH', `/update-agent/${state[variant.key]}`, body)
    : await call('POST', '/create-agent', body);
  state[variant.key] = agent.agent_id;
  results[variant.key] = { id: agent.agent_id, max_minutes: variant.maxMinutes, webhook_url: agent.webhook_url ?? null };
}
state.updated_at = new Date().toISOString();
await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
console.log(JSON.stringify({ llm_id: state.llm_id, model: llmBody.model, ...results }, null, 2));
