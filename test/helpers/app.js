// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a scripted owserver client and a
// virtual clock (fake timers; the monotonic clock moves 1 µs at each read of
// it, so that a decision reading it twice is caught).
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { OwserverApp } from '../../src/app.js';
import { OwError } from '../../src/owserver/client.js';
import { createMemoryStore } from '../../src/store.js';
import { createFakeClock } from './fakeTimers.js';

export const SELECTOR = 'owserver';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const NOW = Date.parse('2026-11-15T10:00:00Z');
export const T28 = '28-4AEC29CDBAAB';
export const T10 = '10-67C6697351FF';
export const C1D = '1D-F2FBE3467CC2';
export const I29 = '29-3158A35A255D';
export const F = (id, key) => `ext:${SELECTOR}:probe:${id}:${key}`;
export const D = (id) => `ext:${SELECTOR}:probe:${id}`;
export const CONFIG = { address: '192.168.1.30' };

/** The values of a default bus, by owserver path. */
export function defaultBus() {
  return {
    '/': `/${T28.replace('-', '.')},/${T10.replace('-', '.')},/${C1D.replace('-', '.')},/${I29.replace('-', '.')},/20.051758E95ED4,/bus.0,/alarm`,
    [`/${T28.replace('-', '.')}/temperature`]: '     21.5625',
    [`/${T10.replace('-', '.')}/temperature`]: '     19.5',
    [`/${C1D.replace('-', '.')}/counters.ALL`]: '         206,         208',
    [`/${I29.replace('-', '.')}/sensed.ALL`]: '0,1,1,1,0,0,0,1',
  };
}

/**
 * A scripted owserver: `bus[path]` -> a string, an OwError, 'hang' (never
 * answers until `release()`), or a function `(path) => one of those`.
 * Counts the requests and the requests in flight.
 */
export function createServer(bus = defaultBus()) {
  const server = { bus, requests: [], inFlight: 0, peak: 0, hanging: [] };
  const answer = async (path) => {
    server.requests.push(path);
    server.inFlight += 1;
    server.peak = Math.max(server.peak, server.inFlight);
    try {
      let value = server.bus[path];
      if (typeof value === 'function') value = await value(path);
      if (value === 'hang') {
        value = await new Promise((resolve) => server.hanging.push(resolve));
      }
      if (value instanceof Error) throw value;
      if (value === undefined) throw new OwError('server', { errno: 1 });
      return value;
    } finally {
      server.inFlight -= 1;
    }
  };
  server.release = (value) => {
    for (const resolve of server.hanging.splice(0)) resolve(value);
  };
  server.count = (path) => server.requests.filter((p) => p === path).length;
  server.factory = (options) => {
    server.options = options;
    const client = {
      closed: false,
      dirall: (path) => answer(path),
      read: (path) => answer(path),
      close() {
        client.closed = true;
        // A request running ends at once, as a closed socket.
        server.release(new OwError('closed'));
      },
    };
    server.client = client;
    return client;
  };
  return server;
}

export const unreachable = () => new OwError('unreachable');

export async function setup({
  devices = [],
  store,
  server = createServer(),
  config = CONFIG,
  wall = { offset: 0 },
} = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices });
  await gladys.connect();
  const { clock, timers, advance, pending } = createFakeClock(NOW);
  let drift = 0;
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  const kept = store ?? createMemoryStore();
  const app = new OwserverApp({
    gladys,
    logger: { lines, info: log, warn: log, error: log, debug: log },
    now: () => clock.now + wall.offset,
    monotonic: () => clock.now + (drift += 0.001),
    timers,
    store: kept,
    clientFactory: server.factory,
  });
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const start = async (cfg = config) => {
    await app.start(cfg);
    await advance(0);
    await app.idle();
    await settle();
  };
  const wait = async (ms) => {
    await advance(ms);
    await app.idle();
    await settle();
  };
  /** The states published, by feature external id (the last one). */
  const lastStates = () => {
    const out = {};
    for (const s of gladys.fake.states) out[s.device_feature_external_id] = s.state;
    return out;
  };
  return {
    app,
    gladys,
    clock,
    store: kept,
    server,
    start,
    wait,
    advance,
    settle,
    pending,
    lines,
    lastStates,
  };
}
