#!/usr/bin/env node
// Local development server. No Netlify account needed.
// Serves public/ and routes /api to the same handler the Netlify function uses,
// backed by PGlite (an in-process Postgres). File uploads are off in this mode (no blob store).
//
//   GEMINI_API_KEY=... npm run dev          # data kept in ./data/pglite
//   DEV_DB=memory npm run dev               # throwaway in-memory data
import { createServer } from 'node:http';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgliteSql } from '../src/db.js';
import { Repository } from '../src/repository.js';
import { GeminiAdapter } from '../src/model.js';
import { createHandler } from '../netlify/functions/api.mjs';

const root = new URL('../', import.meta.url).pathname;
const port = Number(process.env.PORT || 8888);
const env = { ...process.env };
if (!env.ABUSE_HMAC_KEY || env.ABUSE_HMAC_KEY.length < 24) env.ABUSE_HMAC_KEY = randomBytes(24).toString('hex');
if (!env.GEMINI_API_KEY && !env.VERTEX_API_KEY) {
  console.warn('No GEMINI_API_KEY or VERTEX_API_KEY set. The app loads, but every AI step will say the model is not configured.');
}

let db;
if (env.DEV_DB === 'memory') db = new PGlite();
else { await mkdir(join(root, 'data'), { recursive: true }); db = new PGlite(join(root, 'data', 'pglite')); }
const migrations = join(root, 'netlify/database/migrations');
await db.exec('CREATE TABLE IF NOT EXISTS dev_migrations(name text PRIMARY KEY)');
for (const file of (await readdir(migrations)).filter((f) => f.endsWith('.sql')).sort()) {
  const done = await db.query('SELECT 1 FROM dev_migrations WHERE name=$1', [file]);
  if (done.rows.length) continue;
  await db.exec(await readFile(join(migrations, file), 'utf8'));
  await db.query('INSERT INTO dev_migrations(name) VALUES($1)', [file]);
}
const repo = new Repository(pgliteSql(db));
const api = createHandler({ repo, model: new GeminiAdapter({ repo, env }), env });

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.ttf': 'font/ttf', '.txt': 'text/plain', '.png': 'image/png', '.svg': 'image/svg+xml' };

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (url.pathname === '/api') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const response = await api(new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }));
      const headers = {};
      response.headers.forEach((value, name) => { if (name !== 'set-cookie') headers[name] = value; });
      const setCookies = response.headers.getSetCookie?.() ?? [];
      if (setCookies.length) headers['set-cookie'] = setCookies;
      res.writeHead(response.status, headers);
      return res.end(Buffer.from(await response.arrayBuffer()));
    }
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (path.endsWith('/')) path += 'index.html';
    const file = join(root, 'public', path);
    if (!file.startsWith(join(root, 'public'))) { res.writeHead(403); return res.end(); }
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' });
    res.end(data);
  } catch (error) {
    if (!res.headersSent) res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
  }
}).listen(port, '127.0.0.1', () => console.log(`Interview Coach dev server: http://localhost:${port}`));
