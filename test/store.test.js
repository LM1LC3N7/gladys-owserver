// -----------------------------------------------------------------------------
// The real /data store on real files, in a temporary folder removed after.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_STATE_FILE, createFileStore } from '../src/store.js';

async function folder(t) {
  const dir = await mkdtemp(join(tmpdir(), 'owserver-store-'));
  t.after(async () => {
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('the default file is in /data', () => {
  assert.equal(DEFAULT_STATE_FILE, '/data/owserver-state.json');
});

test('a missing file is an empty state; a save then a load give it back', async (t) => {
  const file = join(await folder(t), 'state.json');
  const store = createFileStore(file);
  assert.deepEqual(await store.load(), { ok: true, data: {} });
  await store.save({ version: 1, lastAttemptAt: 5, floors: { a: { value: 3 } } });
  assert.deepEqual(await store.load(), {
    ok: true,
    data: { version: 1, lastAttemptAt: 5, floors: { a: { value: 3 } } },
  });
});

test('written through a temporary file then renamed: none left behind', async (t) => {
  const dir = await folder(t);
  const file = join(dir, 'state.json');
  const store = createFileStore(file);
  await store.save({ n: 1 });
  assert.deepEqual(await readdir(dir), ['state.json']);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { n: 1 });
});

test('saves run one after the other: the last one wins, the file is always whole', async (t) => {
  const dir = await folder(t);
  const file = join(dir, 'state.json');
  const store = createFileStore(file);
  const big = (n) => ({ n, pad: 'x'.repeat(100_000) });
  await Promise.all(Array.from({ length: 20 }, (_, n) => store.save(big(n))));
  const data = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(data.n, 19);
  assert.deepEqual(await readdir(dir), ['state.json']);
});

test('an unreadable file is NOT an empty state', async (t) => {
  const dir = await folder(t);
  // A folder in place of the file: reading it fails (EISDIR).
  const file = join(dir, 'state.json');
  await mkdir(file);
  assert.deepEqual(await createFileStore(file).load(), { ok: false });
});

test('a file that is not a JSON object, or too big, is taken as empty and said invalid', async (t) => {
  const dir = await folder(t);
  const file = join(dir, 'state.json');
  for (const text of ['[1,2]', '"x"', '42', 'null', '{"a":', '']) {
    await writeFile(file, text);
    assert.deepEqual(
      await createFileStore(file).load(),
      { ok: true, data: {}, invalid: true },
      text,
    );
  }
  await writeFile(file, JSON.stringify({ pad: 'x'.repeat(300 * 1024) }));
  assert.deepEqual(await createFileStore(file).load(), { ok: true, data: {}, invalid: true });
});

test('a folder that cannot be written: the save rejects, the next one still runs', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root writes everywhere');
  const dir = await folder(t);
  const file = join(dir, 'state.json');
  const store = createFileStore(file);
  await chmod(dir, 0o500);
  await assert.rejects(store.save({ n: 1 }));
  await chmod(dir, 0o700);
  await store.save({ n: 2 });
  assert.deepEqual((await store.load()).data, { n: 2 });
});
