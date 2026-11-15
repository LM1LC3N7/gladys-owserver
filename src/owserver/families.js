// -----------------------------------------------------------------------------
// The 1-Wire devices read, by family code (the first byte of the ROM id), and
// how a value read from owserver becomes the values of their features. The
// names of the owserver properties (temperature, counters.ALL, sensed.ALL)
// are the documented OWFS device pages; nothing of the OWFS code is used.
//
// Every value is checked strictly: a text that is not a number in the
// expected form, out of range, or a count of values other than expected is
// never published (never a 0 in its place).
// -----------------------------------------------------------------------------

import { COUNTER_MAX, MAX_ENTRIES, POWER_ON_VALUE, TEMP_MAX, TEMP_MIN } from '../constants.js';

const temperature = { kind: 'temperature', path: 'temperature', keys: ['temperature'] };
const inputs = (keys, path = 'sensed.ALL') => ({ kind: 'input', path, keys });

/**
 * `model`, the property read (`path`), the feature keys of its values, and
 * `powerOn`: the DS18x20 family, whose unconverted value is 85 °C.
 */
export const FAMILIES = Object.freeze({
  10: { model: 'DS18S20', read: temperature, powerOn: true },
  22: { model: 'DS1822', read: temperature, powerOn: true },
  28: { model: 'DS18B20', read: temperature, powerOn: true },
  '3B': { model: 'DS1825', read: temperature, powerOn: true },
  42: { model: 'DS28EA00', read: temperature, powerOn: true },
  26: { model: 'DS2438', read: temperature, powerOn: false },
  '1D': {
    model: 'DS2423',
    read: { kind: 'counter', path: 'counters.ALL', keys: ['counter_a', 'counter_b'] },
  },
  '05': { model: 'DS2405', read: inputs(['input'], 'sensed') },
  12: { model: 'DS2406', read: inputs(['input_a', 'input_b']) },
  '3A': { model: 'DS2413', read: inputs(['input_a', 'input_b']) },
  29: {
    model: 'DS2408',
    read: inputs([
      'input_0',
      'input_1',
      'input_2',
      'input_3',
      'input_4',
      'input_5',
      'input_6',
      'input_7',
    ]),
  },
});

/** Names of a few families listed by owserver but not read yet (status only). */
export const OTHER_MODELS = Object.freeze({
  '01': 'DS2401',
  '1F': 'DS2409',
  20: 'DS2450',
  24: 'DS2415',
  27: 'DS2417',
  '2D': 'DS2431',
  '7E': 'EDS00xx',
  EF: 'HobbyBoards',
});

/** Every feature key a device may carry (the forever keys). */
export const KNOWN_KEYS = new Set(Object.values(FAMILIES).flatMap((f) => f.read.keys));

/** A root entry of a device in the `f.i` form: `/28.4AEC29CDBAAB`. */
const ENTRY = /^\/([0-9A-F]{2})\.([0-9A-F]{12})$/;
/** The id kept for a device (external ids, /data): `28-4AEC29CDBAAB`. */
export const PROBE_ID = /^([0-9A-F]{2})-([0-9A-F]{12})$/;

/** The owserver path of a device from its id: `28-4AEC...` -> `/28.4AEC...`. */
export const pathOf = (id) => `/${id.slice(0, 2)}.${id.slice(3)}`;

/**
 * The root directory of owserver (a DIRALL answer, comma-separated), split
 * into the devices read here and the families listed but not read. Special
 * entries (bus.0, settings, alarm...) and anything else are ignored; a
 * device listed twice counts once.
 */
export function parseDirectory(text) {
  const probes = [];
  const others = new Map();
  const seen = new Set();
  const entries = String(text).split(',').slice(0, MAX_ENTRIES);
  for (const raw of entries) {
    const match = ENTRY.exec(raw.trim());
    if (!match) continue;
    const id = `${match[1]}-${match[2]}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const family = FAMILIES[match[1]];
    if (family) {
      probes.push({ id, family: match[1], model: family.model });
    } else {
      others.set(match[1], (others.get(match[1]) ?? 0) + 1);
    }
  }
  return {
    probes,
    others: [...others].map(([family, count]) => ({
      family,
      model: OTHER_MODELS[family] ?? null,
      count,
    })),
  };
}

const DECIMAL = /^-?\d{1,3}(?:\.\d{1,6})?$/;
const INTEGER = /^\d{1,10}$/;

/**
 * The values of one read of a device: `{ values: [[key, number], ...] }`,
 * or `{ error: 'unreadable' | 'out_of_range' }`. Only our checks decide: the
 * text of owserver is never shown.
 */
export function parseValues(familyCode, text) {
  const family = FAMILIES[familyCode];
  if (!family || typeof text !== 'string') {
    return { error: 'unreadable' };
  }
  const { kind, keys } = family.read;
  if (kind === 'temperature') {
    const trimmed = text.trim();
    if (!DECIMAL.test(trimmed)) return { error: 'unreadable' };
    const value = Number(trimmed);
    if (!Number.isFinite(value)) return { error: 'unreadable' };
    if (value < TEMP_MIN || value > TEMP_MAX) return { error: 'out_of_range' };
    return { values: [[keys[0], Number(value.toFixed(2))]] };
  }
  const parts = text.split(',').map((part) => part.trim());
  // A DS2406 in its small package has one channel only: fewer values than
  // keys are taken in order, more are never guessed.
  if (parts.length < 1 || parts.length > keys.length) {
    return { error: 'unreadable' };
  }
  const values = [];
  for (const [i, part] of parts.entries()) {
    if (kind === 'counter') {
      if (!INTEGER.test(part)) return { error: 'unreadable' };
      const value = Number(part);
      if (value > COUNTER_MAX) return { error: 'out_of_range' };
      values.push([keys[i], value]);
    } else {
      if (part !== '0' && part !== '1') return { error: 'unreadable' };
      values.push([keys[i], Number(part)]);
    }
  }
  return { values };
}

/** Whether a temperature of this family is the unconverted power-on value. */
export const isPowerOnValue = (familyCode, value) =>
  FAMILIES[familyCode]?.powerOn === true && value === POWER_ON_VALUE;
