import { createHmac } from 'node:crypto';
import { Repository } from '../../src/repository.js';
import { productionSql } from '../../src/db.js';
import { acceptVoiceWebhook } from '../../src/voice.js';

export function createWebhookHandler({ repo, env = process.env, enqueue = null, now = () => Date.now() }) {
  return async (request) => {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    if (!env.RETELL_WEBHOOK_KEY) return new Response(null, { status: 503 });
    const raw = await request.text();
    if (raw.length > 150000) return new Response(null, { status: 413 });
    const accepted = await acceptVoiceWebhook({ repo, raw,
      signature: request.headers.get('x-retell-signature'), key: env.RETELL_WEBHOOK_KEY, now: now() });
    if (accepted.jobId && enqueue) await enqueue(accepted.jobId, request.url);
    return Response.json({ result: accepted.result }, { status: accepted.status });
  };
}

export default async function handler(request) {
  const repo = new Repository(productionSql());
  return createWebhookHandler({ repo, enqueue: async (jobId, requestUrl) => {
    const url = new URL('/.netlify/functions/voice-process-background', requestUrl);
    const proof = createHmac('sha256', process.env.RETELL_WEBHOOK_KEY).update(jobId).digest('hex');
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId, proof }) });
    if (!response.ok) throw new Error('Voice background job could not be queued');
  } })(request);
}
