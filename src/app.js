// -----------------------------------------------------------------------------
// The integration itself: one owserver read over its network protocol, one
// Gladys device per supported 1-Wire device it lists, the values published
// at each read, the counters never lower than what was published, the test
// and accept buttons. index.js only wires the SDK handlers to it. Read-only:
// nothing but READ and DIRALL messages is ever sent.
//
// One read = the root directory (DIRALL), then one READ per device, one
// after the other (a single connection at a time). A device failing (gone
// from the bus, a bus error, a value not readable) leaves only that device
// unread; a round never takes longer than ROUND_BUDGET (the next round
// starts with the devices left over).
//
// The pace is global and kept across restarts: never two reads less than an
// interval apart, whatever asks (a reconnection, a save of the form, the test
// button, the Discover tab, a device created, a restart of the container: the
// time of the last read is kept in /data and read before the first read).
// Structure taken from gladys-iskra (approved).
//
// Two clocks: `now` (wall clock) dates what /data keeps; `monotonic` paces
// the reads, so that a wall clock set back or forward never stops nor
// hurries them.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { addressText, isComplete, normalizeConfig } from './config.js';
import {
  ATTEMPT_SAVE_EVERY,
  COUNTER_MAX,
  DATA_RETRY,
  DATA_WAIT,
  MAX_PROBES,
  RESET_NEAR,
  RETRY_MAX,
  RETRY_MIN,
  ROUND_BUDGET,
  STATE_HEARTBEAT,
  STATES_PER_MINUTE,
  STOP_WAIT,
  TEST_ANSWER_WITHIN,
} from './constants.js';
import { buildDevice, ids, openingState } from './devices.js';
import { T } from './i18n.js';
import { OwClient, OwError } from './owserver/client.js';
import {
  FAMILIES,
  PROBE_ID,
  isPowerOnValue,
  parseDirectory,
  parseValues,
  pathOf,
} from './owserver/families.js';
import { createFileStore } from './store.js';

const defaultTimers = { setTimeout, clearTimeout };

/** At most this many devices kept in /data (offered in Discovery after a restart). */
const MAX_KEPT_PROBES = 2 * MAX_PROBES;
/** getConfig() failing at a connection: tried again after 5 s, doubled up to 5 min. */
const CONFIG_RETRY_MIN = 5_000;
const CONFIG_RETRY_MAX = 300_000;

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const isCount = (value) => Number.isInteger(value) && value >= 0 && value <= COUNTER_MAX;

/** The value Gladys holds for a feature of a created device, when it says so (an integer). */
function lastCountOf(device, featureId) {
  const feature = (device?.features ?? []).find((f) => f.external_id === featureId);
  const raw = feature?.last_value;
  if (raw === null || raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return isCount(value) ? value : undefined;
}

export class OwserverApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'owserver' }),
    now = Date.now,
    monotonic = () => performance.now(),
    timers = defaultTimers,
    clientFactory = (options) => new OwClient(options),
    store = createFileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.clientFactory = clientFactory;
    this.store = store;
    this.config = normalizeConfig();
    /** `{ client, discovered }` of the current address; replaced when it changes. */
    this.session = undefined;
    this.running = false;
    /** Moved by each stop: a read of before gives up after its next await. */
    this.epoch = 0;
    this.timer = undefined;
    this.busy = undefined;
    this.loopRun = Promise.resolve();
    this.lifecycle = Promise.resolve();
    this.lastStatus = undefined;
    this.configTimer = undefined;
    this.configFailures = 0;

    /** /data: 'idle' (not asked yet) | 'loading' | 'ready' | 'unreadable'. */
    this.dataState = 'idle';
    this.dataSlow = false;
    this.loadRun = undefined;
    this.dataTimer = undefined;
    /** The supported devices seen, by id, the most recently seen last. */
    this.probes = new Map();
    /** By `<id>:<key>` of a counter: `{ value, held?, ignoreUpTo? }`. */
    this.floors = new Map();
    /** The last temperature taken of each probe (the 85 °C check), in memory. */
    this.lastTemp = new Map();
    /** Wall time of the last read (kept in /data) and its monotonic twin. */
    this.lastAttemptAt = undefined;
    this.savedAttemptAt = undefined;
    this.lastReadAt = undefined;
    /** The number of features of a full read: it stretches the interval. */
    this.featureCount = 0;
    /** The position, in the list of devices, the next round starts from. */
    this.cursor = 0;
    this.resetReads();
  }

  /** What belongs to one address: forgotten when it changes. */
  resetReads() {
    /** The last read: `{ at (monotonic), kind: 'reading' | 'error', ... }`. */
    this.outcome = undefined;
    this.failures = 0;
    this.nextTryAt = undefined;
  }

  // --- Lifecycle -------------------------------------------------------------

  start(raw = {}) {
    return this.serialize(() => {
      this.cancelConfigRetry();
      return this.doStart(raw);
    });
  }

  /**
   * A (re)connection to Gladys: its configuration, then a start. getConfig()
   * failing is tried again, spaced, without end, the status saying so.
   */
  connected() {
    return this.serialize(async () => {
      this.cancelConfigRetry();
      let config;
      try {
        config = await this.gladys.getConfig();
      } catch (err) {
        this.configFailures += 1;
        const wait = Math.min(
          CONFIG_RETRY_MIN * 2 ** Math.min(this.configFailures - 1, 10),
          CONFIG_RETRY_MAX,
        );
        this.logger.warn(`owserver: reading the configuration failed (${err?.name ?? 'Error'})`);
        await this.setStatus(false, T.configUnread);
        this.configTimer = this.timers.setTimeout(() => {
          this.configTimer = undefined;
          this.connected().catch(() => {});
        }, wait);
        return;
      }
      this.configFailures = 0;
      await this.doStart(config);
    });
  }

  cancelConfigRetry() {
    if (this.configTimer !== undefined) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
  }

  /**
   * Stops the reads, waits (bounded) for the one running, and writes /data:
   * the time of the last read and the counters are never lost by a clean stop.
   */
  stop() {
    return this.serialize(async () => {
      this.cancelConfigRetry();
      this.doStop();
      this.epoch += 1;
      if (this.dataTimer !== undefined) {
        this.timers.clearTimeout(this.dataTimer);
        this.dataTimer = undefined;
      }
      await this.saveState();
      if (this.busy) {
        let timer;
        await Promise.race([
          this.busy.catch(() => {}),
          new Promise((resolve) => {
            timer = this.timers.setTimeout(resolve, STOP_WAIT);
          }),
        ]);
        this.timers.clearTimeout(timer);
      }
      await this.saveState();
    });
  }

  /** Resolves once every queued start/stop and the read running are done (tests). */
  async idle() {
    await this.lifecycle;
    await this.loopRun;
    await this.busy;
    await this.loadRun;
  }

  serialize(job) {
    const run = this.lifecycle.then(job, job);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  static sessionKey(config) {
    return JSON.stringify([config.host, config.port, config.invalidAddress]);
  }

  async doStart(raw) {
    this.doStop();
    const config = normalizeConfig(raw);
    const first = this.session === undefined;
    const changed = first || OwserverApp.sessionKey(config) !== OwserverApp.sessionKey(this.config);
    this.config = config;
    if (changed) {
      this.session?.client?.close();
      this.session = {
        client: isComplete(config)
          ? this.clientFactory({ host: config.host, port: config.port })
          : undefined,
        discovered: false,
      };
      if (!first) {
        this.resetReads();
        this.cursor = 0;
      }
    }
    this.running = true;
    // The core keeps the connection status, the Discovery list and the last
    // values in memory: a restarted Gladys has lost them, so they are always
    // sent again (the values at the next read, never the old ones now).
    this.lastStatus = undefined;
    this.gladys.forgetPublishedStates?.();
    this.ensureData();
    if (!this.session.client) {
      await this.updateStatus();
      return;
    }
    await this.discover();
    await this.updateStatus();
    this.schedule();
  }

  doStop() {
    this.running = false;
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  // --- /data -------------------------------------------------------------------

  /** Starts reading /data when it is not read yet; one read at a time. */
  ensureData() {
    if (this.dataState === 'ready' || this.loadRun) {
      return this.loadRun;
    }
    if (this.dataTimer !== undefined) {
      this.timers.clearTimeout(this.dataTimer);
      this.dataTimer = undefined;
    }
    this.dataState = 'loading';
    const slow = this.timers.setTimeout(() => {
      this.dataSlow = true;
      if (this.running) this.updateStatus().catch(() => {});
    }, DATA_WAIT);
    const run = (async () => {
      let result;
      try {
        result = await this.store.load();
      } catch {
        result = { ok: false };
      }
      this.timers.clearTimeout(slow);
      this.dataSlow = false;
      if (result?.ok) {
        if (result.invalid) {
          this.logger.warn('owserver: the state file in /data was not valid, started again');
        }
        this.applyKept(result.data ?? {});
        this.dataState = 'ready';
      } else {
        this.dataState = 'unreadable';
        this.logger.warn('owserver: /data cannot be read; trying again in 10 s');
        this.dataTimer = this.timers.setTimeout(() => {
          this.dataTimer = undefined;
          if (this.running) this.ensureData();
        }, DATA_RETRY);
      }
    })().finally(() => {
      this.loadRun = undefined;
    });
    this.loadRun = run;
    run
      .then(async () => {
        if (!this.running) return;
        if (this.dataState === 'ready' && this.session?.client) {
          await this.discover();
          // The interval may have grown with the devices kept.
          this.schedule();
        }
        await this.updateStatus();
      })
      .catch(() => {});
    return run;
  }

  /** Waits for /data while it is being read, at most DATA_WAIT. */
  async waitData() {
    const run = this.loadRun;
    if (!run) return;
    let timer;
    await Promise.race([
      run.catch(() => {}),
      new Promise((resolve) => {
        timer = this.timers.setTimeout(resolve, DATA_WAIT);
      }),
    ]);
    this.timers.clearTimeout(timer);
  }

  /** What /data kept, merged with what this process already knows. */
  applyKept(data) {
    const at = this.now();
    const mono = this.monotonic();
    if (this.lastAttemptAt === undefined && finite(data.lastAttemptAt)) {
      // A date in the future (a clock set back) is brought to now.
      const kept = Math.min(data.lastAttemptAt, at);
      this.lastAttemptAt = kept;
      this.savedAttemptAt = kept;
      if (this.lastReadAt === undefined) {
        this.lastReadAt = mono - (at - kept);
      }
    }
    if (Array.isArray(data.probes)) {
      const kept = new Map();
      for (const id of data.probes.slice(-MAX_KEPT_PROBES)) {
        const match = typeof id === 'string' ? PROBE_ID.exec(id) : null;
        if (match && FAMILIES[match[1]]) {
          kept.set(id, { id, family: match[1], model: FAMILIES[match[1]].model });
        }
      }
      // Seen in this process: after the kept ones (the most recent last).
      for (const [id, probe] of this.probes) {
        kept.delete(id);
        kept.set(id, probe);
      }
      this.probes = kept;
      if (this.featureCount === 0) {
        this.featureCount = this.countFeatures([...kept.values()].slice(-MAX_PROBES));
      }
    }
    const floors = data.floors && typeof data.floors === 'object' ? data.floors : {};
    for (const [key, value] of Object.entries(floors)) {
      if (key === '__proto__' || !/^[0-9A-F]{2}-[0-9A-F]{12}:counter_[ab]$/.test(key)) continue;
      if (!value || typeof value !== 'object' || !isCount(value.value)) continue;
      const mine = this.floors.get(key);
      const floor = { value: Math.max(value.value, mine?.value ?? 0) };
      const held = mine ? mine.held : value.held;
      if (isCount(held) && held < floor.value) floor.held = held;
      const ignore = Math.max(
        isCount(value.ignoreUpTo) ? value.ignoreUpTo : -1,
        mine?.ignoreUpTo ?? -1,
      );
      if (ignore >= 0) floor.ignoreUpTo = ignore;
      this.floors.set(key, floor);
    }
  }

  /**
   * Writes /data, only once it was read (never over a file not read).
   * @returns {Promise<boolean>} whether it was written.
   */
  async saveState() {
    if (this.dataState !== 'ready') {
      return false;
    }
    const floors = {};
    for (const [key, floor] of this.floors) {
      floors[key] = floor;
    }
    try {
      await this.store.save({
        version: 1,
        lastAttemptAt: this.lastAttemptAt ?? null,
        probes: [...this.probes.keys()].slice(-MAX_KEPT_PROBES),
        floors,
      });
      return true;
    } catch (err) {
      this.logger.warn(`owserver: saving /data failed (${err?.code ?? err?.name ?? 'Error'})`);
      return false;
    }
  }

  async saveAttempt(now) {
    this.lastAttemptAt = now;
    if (
      this.savedAttemptAt === undefined ||
      now < this.savedAttemptAt ||
      now - this.savedAttemptAt >= ATTEMPT_SAVE_EVERY
    ) {
      if (await this.saveState()) {
        this.savedAttemptAt = now;
      }
    }
  }

  // --- Pace ------------------------------------------------------------------

  countFeatures(probes) {
    return probes.reduce((sum, p) => sum + FAMILIES[p.family].read.keys.length, 0);
  }

  /** The interval between two reads: the one chosen, longer with many features. */
  interval() {
    return Math.max(
      this.config.intervalSeconds * 1000,
      Math.ceil((this.featureCount * 60_000) / STATES_PER_MINUTE),
    );
  }

  /** The monotonic time from which the next read may start, from the caller's instant `mono`. */
  dueAt(mono) {
    let due = this.lastReadAt === undefined ? mono : this.lastReadAt + this.interval();
    if (this.nextTryAt !== undefined) {
      due = Math.max(due, this.nextTryAt);
    }
    return due;
  }

  /** One timer: the next read when it is due. */
  schedule() {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.running || !this.session?.client) {
      return;
    }
    const mono = this.monotonic();
    const wait = Math.max(0, this.dueAt(mono) - mono);
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.loopRun = this.loop();
    }, wait);
  }

  async loop() {
    const session = this.session;
    try {
      await this.tick();
    } catch (err) {
      this.logger.error(`owserver: unexpected error (${err?.name ?? 'Error'})`);
    }
    if (session === this.session && this.running && this.timer === undefined) {
      this.schedule();
    }
  }

  /** One read when it is due; a read running is never doubled. */
  tick() {
    if (this.busy) {
      return this.busy;
    }
    this.busy = this.read().finally(() => {
      this.busy = undefined;
    });
    return this.busy;
  }

  async read() {
    const session = this.session;
    const client = session?.client;
    const epoch = this.epoch;
    if (!client || !this.running) {
      return;
    }
    /** Another address (or a stop) during an await: this read gives up, silently. */
    const gone = () => session !== this.session || !this.running || epoch !== this.epoch;
    const asked = this.monotonic();
    if (asked < this.dueAt(asked)) {
      return;
    }
    // The time of the last read before a restart is in /data: read first.
    await this.waitData();
    if (gone()) return;
    const mono = this.monotonic();
    if (mono < this.dueAt(mono)) {
      return;
    }
    this.lastReadAt = mono;
    // Kept BEFORE the requests: a restart during them never reads again sooner.
    await this.saveAttempt(this.now());
    if (gone()) return;
    let result;
    try {
      result = await this.readAll(client, gone, mono);
    } catch (err) {
      if (gone()) return;
      await this.failed(err, mono);
      return;
    }
    if (gone() || !result) return;
    await this.succeeded(result, mono, gone);
  }

  /** The root directory, then each supported device once, within the budget. */
  async readAll(client, gone, started) {
    const text = await client.dirall('/');
    if (gone()) return undefined;
    const { probes, others } = parseDirectory(text);
    const listed = probes.slice(0, MAX_PROBES);
    const start = listed.length > 0 ? this.cursor % listed.length : 0;
    const order = [...listed.slice(start), ...listed.slice(0, start)];
    const readings = [];
    const unread = [];
    let tried = 0;
    let down = false;
    for (const probe of order) {
      if (down || this.monotonic() - started >= ROUND_BUDGET) {
        unread.push({ id: probe.id, code: down ? 'unreachable' : 'budget' });
        continue;
      }
      tried += 1;
      const family = FAMILIES[probe.family];
      let raw;
      try {
        raw = await client.read(`${pathOf(probe.id)}/${family.read.path}`);
      } catch (err) {
        if (gone()) return undefined;
        if (!(err instanceof OwError)) throw err;
        // The server itself is gone: the devices left wait for the next round.
        if (err.code === 'unreachable') down = true;
        unread.push({ id: probe.id, code: err.code, errno: err.errno });
        continue;
      }
      if (gone()) return undefined;
      const parsed = parseValues(probe.family, raw);
      if (parsed.error) {
        unread.push({ id: probe.id, code: parsed.error });
        continue;
      }
      readings.push({ id: probe.id, family: probe.family, values: parsed.values });
    }
    this.cursor = listed.length > 0 && tried < listed.length ? (start + tried) % listed.length : 0;
    return {
      listed,
      readings,
      unread,
      others,
      beyond: probes.length - listed.length,
    };
  }

  // --- Outcomes ----------------------------------------------------------------

  async failed(err, mono) {
    this.failures += 1;
    const wait = Math.min(RETRY_MIN * 2 ** Math.min(this.failures - 1, 10), RETRY_MAX);
    this.nextTryAt = mono + wait;
    const code = err instanceof OwError ? err.code : 'closed';
    this.outcome = { at: mono, kind: 'error', code, errno: err?.errno };
    this.logger.warn(`owserver: read failed (${code})`);
    await this.saveState();
    await this.updateStatus();
  }

  async succeeded(result, mono, gone) {
    this.failures = 0;
    this.nextTryAt = undefined;
    let grew = !this.session.discovered;
    for (const probe of result.listed) {
      if (!this.probes.has(probe.id)) grew = true;
      // Seen now: moved last, so that the oldest devices leave /data first.
      this.probes.delete(probe.id);
      this.probes.set(probe.id, probe);
    }
    while (this.probes.size > MAX_KEPT_PROBES) {
      this.probes.delete(this.probes.keys().next().value);
    }
    this.featureCount = this.countFeatures(result.listed);
    const states = [];
    for (const reading of result.readings) {
      reading.shown = [];
      const external = ids(this.gladys, reading.id);
      const kind = FAMILIES[reading.family].read.kind;
      for (const [key, value] of reading.values) {
        let state;
        if (kind === 'temperature') {
          if (isPowerOnValue(reading.family, value)) {
            const before = this.lastTemp.get(reading.id);
            if (before === undefined || Math.abs(before - value) > RESET_NEAR) {
              reading.powerOn = true;
              continue;
            }
          }
          this.lastTemp.set(reading.id, value);
          state = value;
        } else if (kind === 'counter') {
          state = this.counterValue(reading.id, key, value, external.feature(key));
          if (state === undefined) continue;
        } else {
          state = openingState(value);
        }
        reading.shown.push([key, value]);
        states.push({ device_feature_external_id: external.feature(key), state });
      }
    }
    this.outcome = { at: mono, kind: 'reading', ...result };
    if (grew) {
      this.session.discovered = true;
      await this.discover();
      if (gone()) return;
    }
    if (states.length > 0) {
      try {
        await this.gladys.publishChangedStates(states, { heartbeat: STATE_HEARTBEAT });
      } catch (err) {
        // Sent again by the next call (the SDK remembers only what Gladys took).
        this.logger.warn(`owserver: publishing the values failed (${err?.name ?? 'Error'})`);
      }
      if (gone()) return;
    }
    await this.saveState();
    if (gone()) return;
    await this.updateStatus();
  }

  /**
   * A counter is never published lower than before: the floor is the last
   * value published (kept in /data) or the one Gladys holds, the highest. A
   * lower value is held back (status), until "Accept the counter drops".
   * @returns {number | undefined} the value to publish, none when held.
   */
  counterValue(id, key, value, featureId) {
    const name = `${id}:${key}`;
    const floor = this.floors.get(name);
    let base = floor?.value ?? -1;
    const fromGladys = lastCountOf(this.createdDevice(id), featureId);
    if (
      fromGladys !== undefined &&
      !(floor?.ignoreUpTo !== undefined && fromGladys <= floor.ignoreUpTo)
    ) {
      base = Math.max(base, fromGladys);
    }
    if (value >= base) {
      const next = { value };
      if (floor?.ignoreUpTo !== undefined) next.ignoreUpTo = floor.ignoreUpTo;
      this.floors.set(name, next);
      return value;
    }
    this.floors.set(name, { ...floor, value: base, held: value });
    return undefined;
  }

  /** The counters held back: `{ id, key, from, to }`. */
  heldList() {
    const list = [];
    for (const [name, floor] of this.floors) {
      if (floor.held !== undefined) {
        const [id, key] = name.split(':');
        list.push({ id, key, from: floor.value, to: floor.held });
      }
    }
    return list;
  }

  /**
   * "Accept the counter drops": every counter held back takes its lower
   * value as its new floor (a counter reset after a power loss); published
   * from the next read. Saving the configuration never does it.
   */
  async acceptCounterDrops() {
    return this.serialize(async () => {
      const held = this.heldList();
      if (held.length === 0) {
        return T.test.nothingHeld;
      }
      for (const h of held) {
        const name = `${h.id}:${h.key}`;
        const floor = this.floors.get(name);
        const fromGladys = lastCountOf(
          this.createdDevice(h.id),
          ids(this.gladys, h.id).feature(h.key),
        );
        this.floors.set(name, {
          value: h.to,
          ignoreUpTo: Math.max(floor.value, floor.ignoreUpTo ?? -1, fromGladys ?? -1),
        });
      }
      this.logger.info(`owserver: ${held.length} counter drops accepted`);
      const saved = await this.saveState();
      await this.updateStatus();
      const message = T.test.accepted(held);
      return saved
        ? message
        : {
            en: `${message.en} ${T.test.acceptedNotSaved.en}`,
            fr: `${message.fr} ${T.test.acceptedNotSaved.fr}`,
          };
    });
  }

  // --- Status ------------------------------------------------------------------

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(connected, message);
      this.lastStatus = key;
    } catch (err) {
      this.logger.warn(`owserver: setting the status failed (${err?.name ?? 'Error'})`);
    }
  }

  async updateStatus() {
    const [connected, message] = this.currentStatus();
    await this.setStatus(connected, message);
  }

  /** The status from what is known now: never a read. */
  currentStatus() {
    if (!this.session?.client) {
      return [false, this.config.invalidAddress ? T.badAddress : T.incomplete];
    }
    const address = addressText(this.config);
    const notes = [];
    if (this.dataState === 'unreadable') notes.push(T.notes.dataUnreadable);
    else if (this.dataSlow) notes.push(T.notes.dataSlow);
    const held = this.heldList();
    if (held.length > 0) notes.push(T.notes.held(held));
    const o = this.outcome;
    if (!o) {
      return [false, appendNotes(T.waiting(address), notes)];
    }
    if (o.kind === 'error') {
      const mono = this.monotonic();
      return [
        false,
        appendNotes(
          T.failed(address, o.code, o.errno, Math.max(0, this.dueAt(mono) - mono)),
          notes,
        ),
      ];
    }
    const extra = [];
    if (o.unread.length > 0) extra.push(T.notes.unread(o.unread));
    const powerOn = o.readings.filter((r) => r.powerOn).map((r) => r.id);
    if (powerOn.length > 0) extra.push(T.notes.powerOn(powerOn));
    if (o.others.length > 0) extra.push(T.notes.others(o.others));
    if (o.beyond > 0) extra.push(T.notes.beyond(o.beyond));
    const missing = o.listed.filter((p) => !this.createdDevice(p.id)).length;
    if (missing > 0) extra.push(T.notes.notCreated(missing));
    if (o.listed.length > 0 && o.readings.length === 0) {
      return [false, T.noneRead(address, o.listed.length, [...extra, ...notes])];
    }
    return [true, T.ok(address, o.readings.length, o.listed.length, [...extra, ...notes])];
  }

  // --- Devices -----------------------------------------------------------------

  createdDevice(id) {
    const external = ids(this.gladys, id).device;
    return (this.gladys.devices ?? []).find((d) => d.external_id === external);
  }

  /** The devices listed now first, then the ones kept, MAX_KEPT_PROBES at most. */
  discoverable() {
    const listed = this.outcome?.kind === 'reading' ? this.outcome.listed : [];
    const out = new Map(listed.map((p) => [p.id, p]));
    for (const [id, probe] of [...this.probes].reverse()) {
      if (!out.has(id)) out.set(id, probe);
    }
    return [...out.values()].slice(0, MAX_KEPT_PROBES);
  }

  async discover() {
    if (!this.session?.client) {
      return;
    }
    const address = addressText(this.config);
    const devices = this.discoverable().map((p) => buildDevice(this.gladys, p, address));
    await this.gladys
      .publishDiscoveredDevices(devices)
      .catch((err) => this.logger.warn(`owserver: publishing the devices failed (${err?.name})`));
  }

  /** The Discover tab asks: the known devices, never a read (the next one comes at its time). */
  async scan() {
    await this.discover();
  }

  /** A device created or updated: its values come at the next read; the status counts it. */
  async onDeviceChanged() {
    if (this.running) await this.updateStatus();
  }

  // --- Buttons -----------------------------------------------------------------

  async testConnection() {
    if (!this.session?.client) {
      return this.currentStatus()[1];
    }
    const mono = this.monotonic();
    if (this.busy || this.dueAt(mono) > mono) {
      return this.describeOutcome();
    }
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve(T.test.slow), TEST_ANSWER_WITHIN);
    });
    const since = this.monotonic();
    try {
      return await Promise.race([this.tick().then(() => this.describeOutcome(since)), late]);
    } finally {
      this.timers.clearTimeout(timer);
      if (this.running && !this.busy) this.schedule();
    }
  }

  /** The last read in words, and the time to the next one. */
  describeOutcome(since) {
    const mono = this.monotonic();
    const next = Math.max(0, this.dueAt(mono) - mono);
    const o = this.outcome;
    if (!o) {
      return this.session?.client && this.lastReadAt === undefined
        ? T.test.notYet(next)
        : this.currentStatus()[1];
    }
    if (o.kind === 'error') {
      return this.currentStatus()[1];
    }
    const ago = since !== undefined && o.at >= since ? undefined : Math.max(0, mono - o.at);
    const SHOWN = 10;
    const lines = o.readings.slice(0, SHOWN).map((r) => {
      const values = (r.shown ?? []).map(([key, value]) => {
        if (key === 'temperature') return `${value} °C`;
        return `${key} ${value}`;
      });
      const text = values.length > 0 ? values.join(', ') : '—';
      return { en: `${r.id} ${text}`, fr: `${r.id} ${text}` };
    });
    return T.test.reading(lines, ago, next, Math.max(0, o.readings.length - SHOWN));
  }
}

function appendNotes(head, notes) {
  if (notes.length === 0) return head;
  return {
    en: [head.en, ...notes.map((n) => n.en)].join(' '),
    fr: [head.fr, ...notes.map((n) => n.fr)].join(' '),
  };
}
