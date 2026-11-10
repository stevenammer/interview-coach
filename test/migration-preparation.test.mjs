import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareMigrations } from '../scripts/prepare-netlify-migrations.mjs';

test('prepares canonical and legacy migration histories without changing SQL bytes', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'ic-migration-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const source = join(temp, 'source');
  const destination = join(temp, 'destination');
  await cp(resolve('netlify/database/migrations'), source, { recursive: true });
  const canonical = (await readdir(source)).sort();
  assert.equal(canonical.length, 24);
  const defaultSummary = await prepareMigrations({ source, destination, mode: 'default' });
  assert.deepEqual((await readdir(destination)).sort(), canonical);
  assert.equal(defaultSummary.length, 24);
  for (const name of canonical) assert.deepEqual(await readFile(join(destination, name)), await readFile(join(source, name)));

  await writeFile(join(source, '025_future.sql'), '-- future migration\n');
  await prepareMigrations({ source, destination, mode: 'legacy-spend-23' });
  const legacyNames = (await readdir(destination)).sort();
  assert.equal(legacyNames.length, 25);
  assert.ok(legacyNames.includes('023_spend_guard_subject.sql'));
  assert.ok(legacyNames.includes('024_resource_guard.sql'));
  assert.ok(!legacyNames.includes('023_resource_guard.sql'));
  for (const name of [...canonical, '025_future.sql']) {
    const mapped = name === '023_resource_guard.sql' ? '024_resource_guard.sql' :
      name === '024_spend_guard_subject.sql' ? '023_spend_guard_subject.sql' : name;
    assert.deepEqual(await readFile(join(destination, mapped)), await readFile(join(source, name)));
  }
  const before = await readFile(join(destination, '024_resource_guard.sql'));
  await assert.rejects(prepareMigrations({ source, destination, mode: 'unknown' }), /Unknown migration history/);
  assert.deepEqual((await readdir(destination)).sort(), legacyNames);
  assert.deepEqual(await readFile(join(destination, '024_resource_guard.sql')), before);
});
