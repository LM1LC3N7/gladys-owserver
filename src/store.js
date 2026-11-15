// -----------------------------------------------------------------------------
// The state kept in /data (the only writable place of the container): the
// time of the last read, the devices seen, and the floor of each counter
// with a drop held back, so that a restart never reads too soon nor lets a
// counter go down. A small JSON file, written through a temporary file and a
// rename, one save after the other.
//
// Read asynchronously: a slow /data never blocks the event loop. A missing
// file is an empty state; a file that cannot be read (an I/O error, a
// permission) is NOT an empty state: `load()` says so, and the app never
// writes over it until it was read (src/app.js tries again every 10 s).
// -----------------------------------------------------------------------------

import { readFile, rename, stat, writeFile } from 'node:fs/promises';

export const DEFAULT_STATE_FILE = '/data/owserver-state.json';
/** A larger file is not ours: taken as empty (read bounded). */
const MAX_STATE_BYTES = 256 * 1024;

const isObject = (data) => data !== null && typeof data === 'object' && !Array.isArray(data);

export function createFileStore(file = DEFAULT_STATE_FILE) {
  /** The saves one after the other: two never share the temporary file. */
  let queue = Promise.resolve();
  const write = async (data) => {
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(data), 'utf8');
    await rename(tmp, file);
  };
  return {
    /** `{ ok: true, data }` (data `{}` when missing, too big or not JSON), or `{ ok: false }`. */
    async load() {
      try {
        if ((await stat(file)).size > MAX_STATE_BYTES) {
          return { ok: true, data: {}, invalid: true };
        }
        const text = await readFile(file, 'utf8');
        try {
          const data = JSON.parse(text);
          return isObject(data) ? { ok: true, data } : { ok: true, data: {}, invalid: true };
        } catch {
          return { ok: true, data: {}, invalid: true };
        }
      } catch (err) {
        return err?.code === 'ENOENT' ? { ok: true, data: {} } : { ok: false };
      }
    },
    save(data) {
      const job = queue.then(
        () => write(data),
        () => write(data),
      );
      queue = job.catch(() => {});
      return job;
    },
  };
}

/** The same in memory (tests): `failLoad` / `failSave` / `slowLoad` play a broken /data. */
export function createMemoryStore(initial = {}) {
  let data = structuredClone(initial);
  const store = {
    failLoad: false,
    failSave: false,
    /** A promise the load waits for (a slow /data), when set. */
    slowLoad: undefined,
    loads: 0,
    saves: 0,
    async load() {
      store.loads += 1;
      if (store.slowLoad) await store.slowLoad;
      if (store.failLoad) return { ok: false };
      return { ok: true, data: structuredClone(data) };
    },
    async save(next) {
      if (store.failSave) throw new Error('EIO');
      store.saves += 1;
      data = structuredClone(next);
    },
    get data() {
      return data;
    },
  };
  return store;
}
