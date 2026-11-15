// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout), the
// real client and a real local owserver: the reads really start at 0, the
// interval and twice the interval, with a bounded number of timers. The time
// is sped up 20 times (the 30 s interval is 1.5 s) but it is the real clock:
// it moves between any two reads of it. Everything is stopped in t.after.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { OwserverApp } from '../src/app.js';
import { OwClient } from '../src/owserver/client.js';
import { createMemoryStore } from '../src/store.js';
import { owfake } from './helpers/owfake.js';

const SPEED = 20;
const INTERVAL = 30_000;

test('real clock: reads at 0, the interval and twice the interval; timers bounded', async (t) => {
  const fake = await owfake(
    {
      '/': '/28.4AEC29CDBAAB,/1D.F2FBE3467CC2',
      '/28.4AEC29CDBAAB/temperature': '     21.5625',
      '/1D.F2FBE3467CC2/counters.ALL': '         206,         208',
    },
    { latencyMs: 5 },
  );
  let timersSet = 0;
  const live = new Set();
  const timers = {
    setTimeout(fn, ms) {
      timersSet += 1;
      const id = setTimeout(
        () => {
          live.delete(id);
          fn();
        },
        Math.max(0, ms) / SPEED,
      );
      live.add(id);
      return id;
    },
    clearTimeout(id) {
      live.delete(id);
      clearTimeout(id);
    },
  };
  const gladys = createFakeGladys({ selector: 'owserver', config: {} });
  await gladys.connect();
  const quiet = () => {};
  const app = new OwserverApp({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    now: () => Date.now() * SPEED,
    monotonic: () => performance.now() * SPEED,
    timers,
    store: createMemoryStore(),
    // The real client; its own time bounds stay real (never reached here).
    clientFactory: (options) => new OwClient(options),
  });
  t.after(async () => {
    await app.stop();
    for (const id of live) clearTimeout(id);
    await fake.close();
  });
  const started = performance.now() * SPEED;
  await app.start({ address: `127.0.0.1:${fake.port}`, interval_seconds: '30' });
  const dirs = () => fake.at.filter((_, i) => fake.requests[i] === '7 /').map((x) => x * SPEED);
  const deadline = started + 4 * INTERVAL;
  while (dirs().length < 3 && performance.now() * SPEED < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  // A little more: no fourth read before its time.
  const until = (dirs()[2] ?? started) + 0.5 * INTERVAL;
  while (performance.now() * SPEED < until) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const reads = dirs();
  const at = reads.map((x) => Math.round(x - started));
  assert.equal(reads.length, 3, `reads at ${at}`);
  assert.ok(reads[0] - started < INTERVAL / 2, `the first read at once: ${at}`);
  for (let i = 1; i < reads.length; i += 1) {
    const gap = reads[i] - reads[i - 1];
    assert.ok(gap >= 0.9 * INTERVAL, `never sooner than the interval: ${at}`);
    assert.ok(gap < 1.5 * INTERVAL, `on time: ${at}`);
  }
  assert.ok(timersSet <= 20, `${timersSet} timers`);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  const states = Object.fromEntries(
    gladys.fake.states.map((s) => [s.device_feature_external_id, s.state]),
  );
  assert.equal(states['ext:owserver:probe:28-4AEC29CDBAAB:temperature'], 21.56);
  assert.equal(states['ext:owserver:probe:1D-F2FBE3467CC2:counter_b'], 208);
});
