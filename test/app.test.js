// -----------------------------------------------------------------------------
// The app on the SDK's fake Gladys, a scripted owserver and a virtual clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OwError } from '../src/owserver/client.js';
import { createMemoryStore } from '../src/store.js';
import { buildDevice } from '../src/devices.js';
import {
  C1D,
  CONFIG,
  D,
  F,
  I29,
  MINUTE,
  NOW,
  SECOND,
  T10,
  T28,
  createServer,
  defaultBus,
  setup,
  unreachable,
} from './helpers/app.js';

const P = (id, prop) => `/${id.replace('-', '.')}/${prop}`;
const status = (gladys) => gladys.fake.connectionStatus;

/** A created device of a probe, with the value Gladys holds for one feature. */
function created(gladys, id, family, last = {}) {
  const device = buildDevice(gladys, { id, family }, '192.168.1.30');
  for (const f of device.features) {
    const key = f.external_id.split(':').at(-1);
    if (key in last) {
      f.last_value = last[key];
      f.last_value_changed = new Date(NOW - MINUTE).toISOString();
    }
  }
  return device;
}

test('the first read: values of every supported device, devices offered, status', async () => {
  const t = await setup();
  await t.start();
  const states = t.lastStates();
  assert.equal(states[F(T28, 'temperature')], 21.56);
  assert.equal(states[F(T10, 'temperature')], 19.5);
  assert.equal(states[F(C1D, 'counter_a')], 206);
  assert.equal(states[F(C1D, 'counter_b')], 208);
  // sensed 0 (pin pulled low, contact closed) is a closed opening sensor (1).
  assert.equal(states[F(I29, 'input_0')], 1);
  assert.equal(states[F(I29, 'input_1')], 0);
  assert.equal(states[F(I29, 'input_7')], 0);
  assert.deepEqual(
    t.gladys.fake.discoveredDevices.map((d) => d.external_id),
    [D(T28), D(T10), D(C1D), D(I29)],
  );
  const s = status(t.gladys);
  assert.equal(s.connected, true);
  assert.match(s.message.en, /4 of 4 1-Wire devices read/);
  assert.match(s.message.en, /Not supported yet: DS2450 20/);
  assert.match(s.message.fr, /4 appareils 1-Wire lus sur 4/);
  assert.equal(t.server.options.host, '192.168.1.30');
  assert.equal(t.server.options.port, 4304);
  assert.equal(t.server.peak, 1, 'one request at a time');
  await t.app.stop();
});

test('every feature published is a feature of a device offered; read-only', async () => {
  const t = await setup();
  await t.start();
  const offered = new Set(
    t.gladys.fake.discoveredDevices.flatMap((d) => d.features.map((f) => f.external_id)),
  );
  for (const s of t.gladys.fake.states) {
    assert.ok(offered.has(s.device_feature_external_id), s.device_feature_external_id);
  }
  for (const d of t.gladys.fake.discoveredDevices) {
    for (const f of d.features) {
      assert.equal(f.read_only, true);
      assert.notEqual(f.category, 'switch');
      assert.equal(f.supported_options, undefined);
    }
  }
  await t.app.stop();
});

test('never sooner than the interval: test button, start again, scan, connected', async () => {
  const t = await setup();
  await t.start();
  assert.equal(t.server.count('/'), 1);
  await t.app.testConnection();
  await t.start();
  await t.app.scan();
  await t.app.connected();
  await t.wait(0);
  await t.wait(59 * SECOND);
  assert.equal(t.server.count('/'), 1);
  await t.wait(1 * SECOND);
  assert.equal(t.server.count('/'), 2);
  await t.wait(60 * SECOND);
  assert.equal(t.server.count('/'), 3);
  await t.app.stop();
});

test('the test button reads when a read is due, else tells the last read', async () => {
  const t = await setup();
  await t.start();
  const told = await t.app.testConnection();
  assert.match(told.en, /^Read 1 s ago|^Read \d+ s ago/);
  assert.match(told.en, /28-4AEC29CDBAAB 21\.56 °C/);
  assert.match(told.en, /Next read in 1 min/);
  await t.wait(60 * SECOND);
  t.server.bus[P(T28, 'temperature')] = '22';
  // Due again: the click reads now.
  const again = await t.app.testConnection();
  assert.match(again.en, /Read/);
  await t.app.stop();
});

test('the pace survives a restart: the time of the last read is in /data', async () => {
  const store = createMemoryStore();
  const a = await setup({ store });
  await a.start();
  await a.app.stop();
  assert.equal(store.data.lastAttemptAt, NOW);
  // A new process 20 s later: the first read at 60 s after the last one.
  const b = await setup({ store, wall: { offset: 20 * SECOND } });
  await b.start();
  assert.equal(b.server.count('/'), 0);
  await b.wait(39 * SECOND);
  assert.equal(b.server.count('/'), 0);
  await b.wait(1 * SECOND);
  assert.equal(b.server.count('/'), 1);
  await b.app.stop();
});

test('a date of the last read in the future is brought to now', async () => {
  const store = createMemoryStore({ lastAttemptAt: NOW + 10 * 24 * 3600 * 1000 });
  const t = await setup({ store });
  await t.start();
  assert.equal(t.server.count('/'), 0);
  await t.wait(60 * SECOND);
  assert.equal(t.server.count('/'), 1);
  await t.app.stop();
});

test('nothing old is published again at a start: values come with the next read', async () => {
  const t = await setup();
  await t.start();
  const before = t.gladys.fake.states.length;
  await t.app.connected();
  await t.wait(0);
  assert.equal(t.gladys.fake.states.length, before);
  await t.wait(60 * SECOND);
  // All sent again (forgotten at the start), fresh.
  assert.ok(t.gladys.fake.states.length >= before + 12);
  await t.app.stop();
});

test('one device failing never stops the others; it is named in the status', async () => {
  const bus = defaultBus();
  bus[P(T28, 'temperature')] = new OwError('server', { errno: 2 });
  bus[P(T10, 'temperature')] = 'hello';
  bus[P(C1D, 'counters.ALL')] = new OwError('timeout');
  const t = await setup({ server: createServer(bus) });
  await t.start();
  const states = t.lastStates();
  assert.equal(states[F(T28, 'temperature')], undefined);
  assert.equal(states[F(T10, 'temperature')], undefined, 'text is never a 0');
  assert.equal(states[F(I29, 'input_0')], 1);
  const s = status(t.gladys);
  assert.equal(s.connected, true);
  assert.match(s.message.en, /1 of 4/);
  assert.match(s.message.en, /28-4AEC29CDBAAB \(error of owserver 2\)/);
  assert.match(s.message.en, /10-67C6697351FF \(value not readable\)/);
  assert.match(s.message.en, /1D-F2FBE3467CC2 \(no answer in time\)/);
  await t.app.stop();
});

test('every device failing is not "connected"', async () => {
  const bus = defaultBus();
  for (const key of Object.keys(bus))
    if (key !== '/') bus[key] = new OwError('server', { errno: 5 });
  const t = await setup({ server: createServer(bus) });
  await t.start();
  const s = status(t.gladys);
  assert.equal(s.connected, false);
  assert.match(s.message.en, /none of its 4 1-Wire devices could be read/);
  await t.app.stop();
});

test('an unreachable owserver: status, retries spaced, doubled, then back', async () => {
  const bus = defaultBus();
  const root = bus['/'];
  bus['/'] = unreachable();
  const t = await setup({ server: createServer(bus) });
  await t.start();
  assert.equal(status(t.gladys).connected, false);
  assert.match(status(t.gladys).message.en, /unreachable.*Next try in 1 min/);
  await t.wait(60 * SECOND);
  assert.equal(t.server.count('/'), 2);
  // Second failure: 60 s wait (30 s doubled), still never under the interval.
  await t.wait(59 * SECOND);
  assert.equal(t.server.count('/'), 2);
  await t.wait(1 * SECOND);
  assert.equal(t.server.count('/'), 3);
  // Third: 120 s.
  bus['/'] = root;
  await t.wait(119 * SECOND);
  assert.equal(t.server.count('/'), 3);
  await t.wait(1 * SECOND);
  assert.equal(t.server.count('/'), 4);
  assert.equal(status(t.gladys).connected, true);
  await t.app.stop();
});

test('the server gone in the middle of a round: the values read are kept, the rest waits', async () => {
  const bus = defaultBus();
  bus[P(T10, 'temperature')] = unreachable();
  const t = await setup({ server: createServer(bus) });
  await t.start();
  assert.equal(t.lastStates()[F(T28, 'temperature')], 21.56);
  assert.equal(t.server.count(P(C1D, 'counters.ALL')), 0, 'not tried once the server is down');
  await t.app.stop();
});

test('a counter going down is held back, never published, until accepted', async () => {
  const t = await setup();
  await t.start();
  t.server.bus[P(C1D, 'counters.ALL')] = '3,209';
  await t.wait(60 * SECOND);
  let states = t.lastStates();
  assert.equal(states[F(C1D, 'counter_a')], 206);
  assert.equal(states[F(C1D, 'counter_b')], 209);
  assert.match(status(t.gladys).message.en, /1D-F2FBE3467CC2 counter_a 206 → 3/);
  // Saving the form never accepts it.
  await t.start({ ...CONFIG, interval_seconds: '60' });
  t.server.bus[P(C1D, 'counters.ALL')] = '5,210';
  await t.wait(60 * SECOND);
  assert.equal(t.lastStates()[F(C1D, 'counter_a')], 206);
  const told = await t.app.acceptCounterDrops();
  assert.match(told.en, /Accepted.*1D-F2FBE3467CC2 counter_a 5/);
  assert.deepEqual(t.store.data.floors[`${C1D}:counter_a`].value, 5);
  t.server.bus[P(C1D, 'counters.ALL')] = '6,211';
  await t.wait(60 * SECOND);
  states = t.lastStates();
  assert.equal(states[F(C1D, 'counter_a')], 6);
  assert.doesNotMatch(status(t.gladys).message.en, /held back/);
  assert.match((await t.app.acceptCounterDrops()).en, /No counter is held back/);
  await t.app.stop();
});

test('the floor of a counter survives a restart (/data)', async () => {
  const store = createMemoryStore();
  const a = await setup({ store });
  await a.start();
  await a.app.stop();
  const bus = defaultBus();
  bus[P(C1D, 'counters.ALL')] = '100,300';
  const b = await setup({ store, server: createServer(bus), wall: { offset: 2 * MINUTE } });
  await b.start();
  const states = b.lastStates();
  assert.equal(states[F(C1D, 'counter_a')], undefined);
  assert.equal(states[F(C1D, 'counter_b')], 300);
  assert.match(status(b.gladys).message.en, /counter_a 206 → 100/);
  await b.app.stop();
});

test('without /data, the value Gladys holds is the floor; an accepted drop ignores it', async () => {
  const bus = defaultBus();
  bus[P(C1D, 'counters.ALL')] = '100,300';
  const t = await setup({ server: createServer(bus) });
  t.gladys.fake.devices.push(created(t.gladys, C1D, '1D', { counter_a: 500, counter_b: 250 }));
  await t.gladys.getDevices();
  await t.start();
  let states = t.lastStates();
  assert.equal(states[F(C1D, 'counter_a')], undefined, '100 < 500 held by Gladys');
  assert.equal(states[F(C1D, 'counter_b')], 300);
  await t.app.acceptCounterDrops();
  t.server.bus[P(C1D, 'counters.ALL')] = '101,301';
  await t.wait(60 * SECOND);
  states = t.lastStates();
  assert.equal(states[F(C1D, 'counter_a')], 101, 'the stale 500 of Gladys no longer holds it');
  await t.app.stop();
});

test('85 °C: held back unless it follows a temperature near it', async () => {
  const bus = defaultBus();
  bus[P(T28, 'temperature')] = '85';
  const t = await setup({ server: createServer(bus) });
  await t.start();
  assert.equal(t.lastStates()[F(T28, 'temperature')], undefined);
  assert.match(status(t.gladys).message.en, /85 °C held back.*28-4AEC29CDBAAB/);
  t.server.bus[P(T28, 'temperature')] = '80.5';
  await t.wait(60 * SECOND);
  assert.equal(t.lastStates()[F(T28, 'temperature')], 80.5);
  t.server.bus[P(T28, 'temperature')] = '85.0000';
  await t.wait(60 * SECOND);
  assert.equal(t.lastStates()[F(T28, 'temperature')], 85);
  t.server.bus[P(T28, 'temperature')] = '20';
  await t.wait(60 * SECOND);
  t.server.bus[P(T28, 'temperature')] = '85';
  await t.wait(60 * SECOND);
  assert.equal(t.lastStates()[F(T28, 'temperature')], 20);
  await t.app.stop();
});

test('the round budget: a slow bus leaves the rest for the next round, in turn', async () => {
  const bus = defaultBus();
  const t = await setup({ server: createServer(bus) });
  // Every read takes 25 s of the virtual clock.
  for (const key of Object.keys(bus)) {
    if (key === '/') continue;
    const value = bus[key];
    bus[key] = async () => {
      await t.advance(25 * SECOND);
      return value;
    };
  }
  await t.start();
  // 3 reads in 60 s (25, 50, 75 > 60 stops before the 4th).
  assert.equal(t.server.count(P(I29, 'sensed.ALL')), 0);
  assert.match(status(t.gladys).message.en, /29-3158A35A255D \(not read this time \(slow bus\)\)/);
  await t.wait(60 * SECOND);
  await t.wait(0);
  assert.ok(
    t.server.count(P(I29, 'sensed.ALL')) >= 1,
    'the device left over is read first next time',
  );
  await t.app.stop();
});

test('a new address: the late answer of the old one publishes nothing', async () => {
  const bus = defaultBus();
  let finish;
  // An answer already on its way: it arrives even though the client closed.
  bus['/'] = () => new Promise((resolve) => (finish = resolve));
  const server = createServer(bus);
  const t = await setup({ server });
  await t.app.start(CONFIG);
  await t.advance(0);
  await t.settle();
  const oldClient = server.client;
  await t.app.start({ address: '192.168.1.31' });
  assert.equal(oldClient.closed, true);
  server.bus['/'] = defaultBus()['/'];
  finish(defaultBus()['/']);
  await t.settle();
  assert.equal(t.gladys.fake.states.length, 0);
  assert.equal(server.count(P(T28, 'temperature')), 0);
  assert.match(status(t.gladys).message.en, /Waiting for the first read of 192\.168\.1\.31/);
  await t.app.stop();
});

test('a stop: no timer left, nothing read after it', async () => {
  const t = await setup();
  await t.start();
  await t.app.testConnection();
  const saves = t.store.saves;
  await t.app.stop();
  // Counted at once: a lost timer would have fired after 10 minutes.
  assert.equal(t.pending.size, 0);
  assert.ok(t.store.saves > saves, '/data written by a clean stop');
  const reads = t.server.requests.length;
  await t.wait(10 * MINUTE);
  assert.equal(t.server.requests.length, reads);
  assert.equal(t.pending.size, 0);
});

test('many features: the interval is lengthened (250 values a minute at most)', async () => {
  const ids = Array.from({ length: 40 }, (_, i) => `29-${String(i).padStart(12, '0')}`);
  const bus = { '/': ids.map((id) => `/${id.replace('-', '.')}`).join(',') };
  for (const id of ids) bus[P(id, 'sensed.ALL')] = '0,0,0,0,0,0,0,0';
  const t = await setup({ server: createServer(bus) });
  await t.start();
  // 320 features: 320 * 60 / 250 = 76.8 s.
  await t.wait(76 * SECOND);
  assert.equal(t.server.count('/'), 1);
  await t.wait(1 * SECOND);
  assert.equal(t.server.count('/'), 2);
  await t.app.stop();
});

test('more than 64 devices: 64 read, the rest told', async () => {
  const ids = Array.from({ length: 70 }, (_, i) => `28-${String(i).padStart(12, '0')}`);
  const bus = { '/': ids.map((id) => `/${id.replace('-', '.')}`).join(',') };
  for (const id of ids) bus[P(id, 'temperature')] = '20';
  const t = await setup({ server: createServer(bus) });
  await t.start();
  assert.equal(t.server.requests.length, 65);
  assert.match(status(t.gladys).message.en, /6 more devices are not read/);
  await t.app.stop();
});

test('/data unreadable: never written over, read again every 10 s, counters still guarded', async () => {
  const store = createMemoryStore({ lastAttemptAt: NOW - 30 * SECOND, floors: {} });
  store.failLoad = true;
  const t = await setup({ store });
  t.gladys.fake.devices.push(created(t.gladys, C1D, '1D', { counter_a: 900 }));
  await t.gladys.getDevices();
  await t.start();
  assert.equal(store.saves, 0, 'never written over a file not read');
  assert.equal(t.lastStates()[F(C1D, 'counter_a')], undefined, 'held by the value of Gladys');
  assert.match(status(t.gladys).message.en, /\/data folder cannot be read/);
  const loads = store.loads;
  await t.wait(10 * SECOND);
  assert.equal(store.loads, loads + 1);
  await t.wait(10 * SECOND);
  assert.equal(store.loads, loads + 2);
  store.failLoad = false;
  await t.wait(10 * SECOND);
  assert.doesNotMatch(status(t.gladys).message.en, /cannot be read/);
  await t.wait(30 * SECOND);
  assert.ok(store.saves >= 1);
  assert.equal(store.data.floors[`${C1D}:counter_a`].value, 900);
  await t.app.stop();
});

test('/data slow: the first read waits for it, bounded, and keeps the pace it holds', async () => {
  const store = createMemoryStore({ lastAttemptAt: NOW - 50 * SECOND });
  let release;
  store.slowLoad = new Promise((resolve) => (release = resolve));
  const t = await setup({ store });
  await t.app.start(CONFIG);
  await t.advance(0);
  await t.settle();
  assert.equal(t.server.count('/'), 0, 'waiting for /data');
  await t.advance(5 * SECOND);
  await t.settle();
  release();
  await t.settle();
  // /data said 50 s ago: the read comes at 10 s, not at once.
  assert.equal(t.server.count('/'), 0);
  await t.wait(5 * SECOND);
  assert.equal(t.server.count('/'), 1);
  await t.app.stop();
});

test('/data that never answers: the read goes on after 10 s, nothing saved', async () => {
  const store = createMemoryStore();
  store.slowLoad = new Promise(() => {});
  const t = await setup({ store });
  await t.app.start(CONFIG);
  await t.advance(0);
  await t.settle();
  assert.equal(t.server.count('/'), 0);
  await t.advance(10 * SECOND);
  await t.settle();
  assert.equal(t.server.count('/'), 1);
  assert.equal(store.saves, 0);
  assert.match(status(t.gladys).message.en, /slow to read/);
  t.app.doStop();
});

test('getConfig() failing at a connection: tried again, spaced, until it answers', async () => {
  const t = await setup();
  const real = t.gladys.getConfig.bind(t.gladys);
  let fail = 2;
  let calls = 0;
  t.gladys.getConfig = async () => {
    calls += 1;
    if (fail > 0) {
      fail -= 1;
      throw new Error('boom');
    }
    return real();
  };
  await t.app.connected();
  assert.equal(status(t.gladys).connected, false);
  assert.match(status(t.gladys).message.en, /configuration could not be read/);
  assert.equal(calls, 1);
  await t.wait(5 * SECOND);
  assert.equal(calls, 2);
  await t.wait(9 * SECOND);
  assert.equal(calls, 2, 'doubled: 10 s');
  await t.wait(1 * SECOND);
  assert.equal(calls, 3);
  await t.wait(0);
  assert.equal(t.server.count('/'), 1);
  assert.equal(status(t.gladys).connected, true);
  await t.app.stop();
});

test('a missing or invalid address: status, no read', async () => {
  const t = await setup({ config: {} });
  await t.start({});
  assert.match(status(t.gladys).message.en, /Enter the address/);
  await t.start({ address: '0.0.0.0' });
  assert.match(status(t.gladys).message.en, /not valid/);
  assert.equal(t.server.requests.length, 0);
  assert.match((await t.app.testConnection()).en, /not valid/);
  await t.app.stop();
});

test('the devices kept in /data are offered at a start, before any read', async () => {
  const store = createMemoryStore({ lastAttemptAt: NOW, probes: [T28, 'bad', '99-000000000000'] });
  const t = await setup({ store });
  await t.start();
  assert.deepEqual(
    t.gladys.fake.discoveredDevices.map((d) => d.external_id),
    [D(T28)],
  );
  await t.app.stop();
});

test('/data written: no secret, only ids, counters and the time', async () => {
  const t = await setup();
  await t.start();
  await t.app.stop();
  assert.deepEqual(Object.keys(t.store.data).sort(), [
    'floors',
    'lastAttemptAt',
    'probes',
    'version',
  ]);
  assert.ok(t.store.data.probes.includes(T28));
});

test('a save failing never breaks a read', async () => {
  const store = createMemoryStore();
  store.failSave = true;
  const t = await setup({ store });
  await t.start();
  assert.equal(t.lastStates()[F(T28, 'temperature')], 21.56);
  assert.equal(status(t.gladys).connected, true);
  await t.app.stop();
});

test('publishing failing: logged, the next read sends again', async () => {
  const t = await setup();
  const real = t.gladys.publishChangedStates.bind(t.gladys);
  let fail = true;
  t.gladys.publishChangedStates = async (...args) => {
    if (fail) throw new Error('429');
    return real(...args);
  };
  await t.start();
  assert.equal(t.gladys.fake.states.length, 0);
  fail = false;
  await t.wait(60 * SECOND);
  assert.equal(t.lastStates()[F(T28, 'temperature')], 21.56);
  await t.app.stop();
});

test('a read running across a stop and a start publishes nothing', async () => {
  const bus = defaultBus();
  bus['/'] = 'hang';
  const server = createServer(bus);
  const t = await setup({ server });
  await t.app.start(CONFIG);
  await t.advance(0);
  await t.settle();
  assert.equal(server.hanging.length, 1);
  const stopping = t.app.stop();
  await t.settle();
  await t.advance(5 * SECOND);
  await stopping;
  await t.app.start(CONFIG);
  server.release(defaultBus()['/']);
  await t.settle();
  assert.equal(t.gladys.fake.states.length, 0);
  assert.equal(server.count(P(T28, 'temperature')), 0);
  await t.app.stop();
});

test('a stop while a read hangs: bounded, the client closed, no timer left', async () => {
  const bus = defaultBus();
  bus['/'] = 'hang';
  const server = createServer(bus);
  const t = await setup({ server });
  await t.app.start(CONFIG);
  await t.advance(0);
  await t.settle();
  const client = server.client;
  // The read ends with the closed client, long before the 5 s of STOP_WAIT.
  await t.app.stop();
  assert.equal(client.closed, true);
  assert.equal(t.pending.size, 0);
});

test('a /data write that never answers holds neither the reads nor the stop', async () => {
  const store = createMemoryStore();
  const t = await setup({ store });
  await t.start();
  assert.equal(t.server.count('/'), 1);
  // From now on, every save hangs for ever.
  let hung = 0;
  store.save = () => {
    hung += 1;
    return new Promise(() => {});
  };
  for (let i = 0; i < 4; i += 1) {
    await t.advance(60 * SECOND);
    await t.settle();
    await t.advance(10 * SECOND);
    await t.settle();
    await t.advance(10 * SECOND);
    await t.settle();
  }
  assert.ok(t.server.count('/') >= 4, `${t.server.count('/')} reads`);
  assert.equal(hung, 1, 'one write at a time');
  assert.match(status(t.gladys).message.en, /does not finish writing/);
  const stopping = t.app.stop();
  for (let i = 0; i < 6; i += 1) {
    await t.settle();
    await t.advance(10 * SECOND);
  }
  let done = false;
  stopping.then(() => (done = true));
  await t.settle();
  assert.equal(done, true, 'stop() is bounded');
});

test('a round longer than the interval: the bus rests half an interval', async () => {
  const bus = defaultBus();
  const t = await setup({ server: createServer(bus) });
  for (const key of Object.keys(bus)) {
    if (key === '/') continue;
    const value = bus[key];
    bus[key] = async () => {
      await t.advance(15 * SECOND);
      return value;
    };
  }
  // 4 devices of 15 s: a round of 60 s for an interval of 30 s.
  await t.start({ ...CONFIG, interval_seconds: '30' });
  assert.equal(t.server.count('/'), 1);
  await t.wait(14 * SECOND);
  assert.equal(t.server.count('/'), 1, 'resting');
  await t.wait(1 * SECOND);
  assert.equal(t.server.count('/'), 2);
  t.app.doStop();
});

test('a counter that rises again after an accepted drop is never held by the old value of Gladys', async () => {
  const bus = defaultBus();
  bus[P(C1D, 'counters.ALL')] = '100,300';
  const t = await setup({ server: createServer(bus) });
  t.gladys.fake.devices.push(created(t.gladys, C1D, '1D', { counter_a: 500 }));
  await t.gladys.getDevices();
  await t.start();
  await t.app.acceptCounterDrops();
  for (const value of [101, 102, 103]) {
    t.server.bus[P(C1D, 'counters.ALL')] = `${value},300`;
    await t.wait(60 * SECOND);
    assert.equal(t.lastStates()[F(C1D, 'counter_a')], value);
  }
  await t.app.stop();
});

test('/data read late: the highest floor of /data and memory wins', async () => {
  const store = createMemoryStore({
    floors: { [`${C1D}:counter_a`]: { value: 500 }, [`${C1D}:counter_b`]: { value: 100 } },
  });
  let release;
  store.slowLoad = new Promise((resolve) => (release = resolve));
  const t = await setup({ store });
  await t.app.start(CONFIG);
  await t.advance(0);
  await t.settle();
  await t.advance(10 * SECOND);
  await t.settle();
  // Read without /data: 206 and 208 published (no floor known yet).
  assert.equal(t.lastStates()[F(C1D, 'counter_b')], 208);
  release();
  await t.settle();
  await t.app.idle();
  t.server.bus[P(C1D, 'counters.ALL')] = '300,150';
  await t.wait(60 * SECOND);
  const held = t.app.heldList();
  assert.deepEqual(
    held.map((h) => [h.key, h.from, h.to]),
    [
      ['counter_a', 500, 300],
      ['counter_b', 208, 150],
    ],
  );
  await t.app.stop();
});

test('floors of /data and values of Gladys that are not counts are ignored', async () => {
  const store = createMemoryStore({
    floors: {
      [`${C1D}:counter_a`]: { value: 1e99 },
      [`${C1D}:counter_b`]: { value: -5 },
      __proto__: { value: 1 },
    },
  });
  const t = await setup({ store });
  t.gladys.fake.devices.push(created(t.gladys, C1D, '1D', { counter_a: 1.5 }));
  await t.gladys.getDevices();
  await t.start();
  assert.equal(t.lastStates()[F(C1D, 'counter_a')], 206);
  assert.equal(t.lastStates()[F(C1D, 'counter_b')], 208);
  await t.app.stop();
  for (const bad of [1e99, -1, 'abc']) {
    const u = await setup();
    u.gladys.fake.devices.push(created(u.gladys, C1D, '1D', { counter_b: bad }));
    await u.gladys.getDevices();
    await u.start();
    assert.equal(u.lastStates()[F(C1D, 'counter_b')], 208, String(bad));
    await u.app.stop();
  }
});

test('getConfig(): a stop cancels the retry; a success resets the spacing', async () => {
  const t = await setup();
  const real = t.gladys.getConfig.bind(t.gladys);
  let fail = true;
  let calls = 0;
  t.gladys.getConfig = async () => {
    calls += 1;
    if (fail) throw new Error('boom');
    return real();
  };
  await t.app.connected();
  await t.wait(5 * SECOND);
  assert.equal(calls, 2);
  await t.app.stop();
  await t.wait(10 * MINUTE);
  assert.equal(calls, 2, 'no retry after a stop');
  fail = false;
  await t.app.connected();
  assert.equal(calls, 3);
  fail = true;
  await t.app.connected();
  await t.wait(5 * SECOND);
  assert.equal(calls, 5, 'spacing back to 5 s after a success');
  await t.app.stop();
});

test('an owserver down for long: retries capped at 10 minutes', async () => {
  const bus = defaultBus();
  bus['/'] = unreachable();
  const t = await setup({ server: createServer(bus) });
  await t.start();
  const gaps = [60, 60, 120, 240, 480, 600, 600];
  for (const gap of gaps) {
    const before = t.server.count('/');
    await t.wait((gap - 1) * SECOND);
    assert.equal(t.server.count('/'), before, `not before ${gap} s`);
    await t.wait(1 * SECOND);
    assert.equal(t.server.count('/'), before + 1, `at ${gap} s`);
  }
  await t.app.stop();
});

test('a start sends the status again even when it did not change (Gladys restarted)', async () => {
  const t = await setup();
  await t.start();
  const sent = t.gladys.fake.connectionStatuses.length;
  await t.app.updateStatus();
  assert.equal(t.gladys.fake.connectionStatuses.length, sent, 'not sent twice in a row');
  await t.start();
  assert.ok(t.gladys.fake.connectionStatuses.length > sent);
  await t.app.stop();
});

test('85 °C after 100 °C is held back (too far from it)', async () => {
  const bus = defaultBus();
  bus[P(T28, 'temperature')] = '100';
  const t = await setup({ server: createServer(bus) });
  await t.start();
  t.server.bus[P(T28, 'temperature')] = '85';
  await t.wait(60 * SECOND);
  assert.equal(t.lastStates()[F(T28, 'temperature')], 100);
  t.server.bus[P(T28, 'temperature')] = '84.996';
  await t.wait(60 * SECOND);
  assert.equal(t.lastStates()[F(T28, 'temperature')], 85, '84.996 is a measure');
  await t.app.stop();
});

test('an unchanged value is sent again after 10 minutes (heartbeat asked of the SDK)', async () => {
  const t = await setup();
  const options = [];
  const real = t.gladys.publishChangedStates.bind(t.gladys);
  t.gladys.publishChangedStates = (states, opts) => {
    options.push(opts);
    return real(states, opts);
  };
  await t.start();
  assert.deepEqual(options, [{ heartbeat: 10 * MINUTE }]);
  await t.app.stop();
});

test('a stop waiting for a read that ends by itself: its wait timer is cleared', async () => {
  const bus = defaultBus();
  const t = await setup({ server: createServer(bus) });
  let finish;
  // A read that does not end with the closed client, but 2 s later.
  bus['/'] = () => new Promise((resolve) => (finish = resolve));
  await t.app.start(CONFIG);
  await t.advance(0);
  await t.settle();
  const stopping = t.app.stop();
  await t.settle();
  finish(defaultBus()['/']);
  await stopping;
  assert.equal(t.pending.size, 0);
});
