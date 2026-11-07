import { Repository, hash } from '../../src/repository.js';
import { productionSql } from '../../src/db.js';
import { GeminiAdapter } from '../../src/model.js';
import { sessionToken } from '../../src/auth.js';
import { runModelJob } from '../../src/jobs.js';

export function createBackgroundHandler({ repo, model }) {
  return async (request) => {
    const url = new URL(request.url);
    if (request.method !== 'POST' || request.headers.get('origin') !== url.origin ||
      request.headers.get('x-coach-csrf') !== '1') return new Response(null, { status: 403 });
    const token = sessionToken(request);
    const user = token && await repo.session(hash(token));
    if (!user) return new Response(null, { status: 401 });
    let data;
    try { data = await request.json(); } catch { return new Response(null, { status: 400 }); }
    if (typeof data.jobId !== 'string') return new Response(null, { status: 400 });
    const started = await runModelJob(repo, model, user.id, data.jobId);
    return new Response(null, { status: started ? 200 : 404 });
  };
}

export default async function handler(request) {
  const repo = new Repository(productionSql());
  const model = new GeminiAdapter({ repo });
  return createBackgroundHandler({ repo, model })(request);
}
