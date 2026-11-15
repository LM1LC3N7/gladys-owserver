// -----------------------------------------------------------------------------
// The Gladys devices: one per 1-Wire device read, its features from its
// family (src/owserver/families.js). Everything is read-only: no feature is
// ever commanded, the outputs of the 1-Wire switches are not offered.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { COUNTER_MAX, EXTERNAL_ID_TYPE, TEMP_MAX, TEMP_MIN } from './constants.js';
import { FAMILIES } from './owserver/families.js';

/** The external ids of the 1-Wire device with this id (`28-4AEC29CDBAAB`). */
export const ids = (gladys, probeId) => gladys.externalIds(EXTERNAL_ID_TYPE, probeId);

const base = { read_only: true, has_feedback: false, keep_history: true };

const NAMES = {
  temperature: 'Temperature',
  counter_a: 'Counter A',
  counter_b: 'Counter B',
  input: 'Input',
  input_a: 'Input A',
  input_b: 'Input B',
};

/** The feature of one key. */
function featureOf(external, kind, key) {
  const name = NAMES[key] ?? `Input ${key.slice('input_'.length)}`;
  const id = external.feature(key);
  if (kind === 'temperature') {
    return {
      ...base,
      name,
      external_id: id,
      category: C.TEMPERATURE_SENSOR,
      type: T.SENSOR.DECIMAL,
      unit: U.CELSIUS,
      min: TEMP_MIN,
      max: TEMP_MAX,
    };
  }
  if (kind === 'counter') {
    return {
      ...base,
      name,
      external_id: id,
      category: C.COUNTER_SENSOR,
      type: T.SENSOR.INTEGER,
      min: 0,
      max: COUNTER_MAX,
    };
  }
  return {
    ...base,
    name,
    external_id: id,
    category: C.OPENING_SENSOR,
    type: T.SENSOR.BINARY,
    min: 0,
    max: 1,
  };
}

/** The device of a 1-Wire device `{ id, family }`. */
export function buildDevice(gladys, probe, address) {
  const family = FAMILIES[probe.family];
  const external = ids(gladys, probe.id);
  return {
    name: `${family.model} ${probe.id}`,
    external_id: external.device,
    features: family.read.keys.map((key) => featureOf(external, family.read.kind, key)),
    params: [
      { name: 'owserver_address', value: address },
      { name: 'rom_id', value: probe.id },
      { name: 'model', value: family.model },
    ],
  };
}

/**
 * The state of an input for Gladys: owserver gives the level of the pin
 * (`sensed`): 1 when it is high (a contact open, held up by its pull-up), 0
 * when it is pulled low (a contact closed to ground). The Gladys opening
 * sensor says 1 for closed, 0 for open.
 */
export const openingState = (sensed) => (sensed === 0 ? 1 : 0);
