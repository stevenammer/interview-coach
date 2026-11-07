import { createHmac, timingSafeEqual } from 'node:crypto';
import { Repository } from '../../src/repository.js';
import { productionSql } from '../../src/db.js';
import { GeminiAdapter } from '../../src/model.js';
import { runModelJob } from '../../src/jobs.js';

export function createVoiceBackgroundHandler({ repo, model, key }) {
  return async (request) => {
    if (request.method !== 'POST' || !key) return new Response(null, { status: 403 });
    let data;
    try {
      const chunks = []; let length = 0;
      const reader = request.body?.getReader();
      if (reader) for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 1024) { await reader.cancel(); return new Response(null, { status: 413 }); }
        chunks.push(Buffer.from(value));
      }
      data = JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) return new Response(null, { status: 400 });
    } catch { return new Response(null, { status: 400 }); }
    if (typeof data.jobId !== 'string' || !/^[0-9a-f-]{36}$/i.test(data.jobId) ||
      typeof data.proof !== 'string' || !/^[0-9a-f]{64}$/i.test(data.proof)) {
      return new Response(null, { status: 403 });
    }
    const expected = createHmac('sha256', key).update(data.jobId).digest();
    if (!timingSafeEqual(expected, Buffer.from(data.proof, 'hex'))) return new Response(null, { status: 403 });
    const rows = await repo.sql("SELECT user_id FROM model_jobs WHERE id=$1 AND kind='voice_finish'", [data.jobId]);
    if (!rows.length) return new Response(null, { status: 404 });
    await runModelJob(repo, model, rows[0].user_id, data.jobId);
    return new Response(null, { status: 200 });
  };
}

export default async function handler(request) {
  const repo = new Repository(productionSql());
  return createVoiceBackgroundHandler({ repo, model: new GeminiAdapter({ repo }),
    key: process.env.RETELL_WEBHOOK_KEY })(request);
}
