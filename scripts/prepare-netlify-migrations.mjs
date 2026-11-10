import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const legacyNames = new Map([
  ['023_resource_guard.sql', '024_resource_guard.sql'],
  ['024_spend_guard_subject.sql', '023_spend_guard_subject.sql'],
]);

export async function prepareMigrations({
  source = join(root, 'netlify/database/migrations'),
  destination = join(root, '.netlify/runtime-migrations'),
  mode = process.env.IC_MIGRATION_HISTORY ?? 'default',
} = {}) {
  if (!['default', 'legacy-spend-23'].includes(mode)) throw new Error(`Unknown migration history mode: ${mode}`);
  source = resolve(source);
  destination = resolve(destination);
  if (source === destination || source.startsWith(destination + sep) || destination.startsWith(source + sep)) {
    throw new Error('Migration source and destination must be separate directories.');
  }
  const entries = await readdir(source, { withFileTypes: true });
  const names = entries.map((entry) => {
    if (!entry.isFile() || !/^\d{3,}_[a-z0-9_]+\.sql$/.test(entry.name)) throw new Error(`Unsafe migration entry: ${entry.name}`);
    return entry.name;
  }).sort();
  if (mode === 'legacy-spend-23' && [...legacyNames.keys()].some((name) => !names.includes(name))) {
    throw new Error('Legacy mode requires both canonical 023 and 024 migrations.');
  }
  const outputNames = names.map((name) => mode === 'legacy-spend-23' ? legacyNames.get(name) ?? name : name);
  if (new Set(outputNames).size !== outputNames.length) throw new Error('Migration output names collide.');

  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(join(parent, '.migration-stage-'));
  let backup;
  try {
    const summary = [];
    for (let i = 0; i < names.length; i++) {
      const bytes = await readFile(join(source, names[i]));
      await writeFile(join(stage, outputNames[i]), bytes, { flag: 'wx' });
      summary.push({ name: outputNames[i], sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    backup = `${stage}-previous`;
    try { await rename(destination, backup); } catch (error) { if (error.code !== 'ENOENT') throw error; backup = undefined; }
    try { await rename(stage, destination); } catch (error) {
      if (backup) await rename(backup, destination);
      throw error;
    }
    if (backup) await rm(backup, { recursive: true, force: true });
    return summary.sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const summary = await prepareMigrations();
    for (const { name, sha256 } of summary) console.log(`${sha256}  ${name}`);
  } catch (error) {
    console.error(`Migration preparation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
