import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAMILIES,
  KNOWN_KEYS,
  isPowerOnValue,
  parseDirectory,
  parseValues,
  pathOf,
} from '../src/owserver/families.js';

// The root directory of `owserver --fake=10,28,1D,12,3A,26,29,20` (real
// answer, special directories asked with the bus_ret flag).
const REAL_ROOT =
  '/10.67C6697351FF,/28.4AEC29CDBAAB,/1D.F2FBE3467CC2,/12.54F81BE8E78D,/3A.765A2E63339F,/26.C99A66320DB7,/29.3158A35A255D,/20.051758E95ED4,/bus.0,/uncached,/settings,/system,/statistics,/structure,/simultaneous,/alarm';

test('the root directory: the supported devices, the other families, nothing else', () => {
  const { probes, others } = parseDirectory(REAL_ROOT);
  assert.deepEqual(
    probes.map((p) => [p.id, p.model]),
    [
      ['10-67C6697351FF', 'DS18S20'],
      ['28-4AEC29CDBAAB', 'DS18B20'],
      ['1D-F2FBE3467CC2', 'DS2423'],
      ['12-54F81BE8E78D', 'DS2406'],
      ['3A-765A2E63339F', 'DS2413'],
      ['26-C99A66320DB7', 'DS2438'],
      ['29-3158A35A255D', 'DS2408'],
    ],
  );
  assert.deepEqual(others, [{ family: '20', model: 'DS2450', count: 1 }]);
});

test('the root directory: duplicates, aliases, paths and junk are ignored', () => {
  const { probes, others } = parseDirectory(
    'x/28.4AEC29CDBAAD,/28.4AEC29CDBAAEx,/28.4AEC29CDBAAB,/28.4AEC29CDBAAB, /28.4AEC29CDBAAC ,/kitchen,/28.4aec29cdbaab,/28.4AEC29CDBAAB/x,/../28.4AEC29CDBAAB,/28.4AEC29CDBAA,/__proto__,,/99.000000000000',
  );
  assert.deepEqual(
    probes.map((p) => p.id),
    ['28-4AEC29CDBAAB', '28-4AEC29CDBAAC'],
  );
  assert.deepEqual(others, [{ family: '99', model: null, count: 1 }]);
  assert.deepEqual(parseDirectory(''), { probes: [], others: [] });
});

test('the root directory: a huge list is bounded', () => {
  const many = Array.from({ length: 5000 }, (_, i) => `/28.${String(i).padStart(12, '0')}`).join(
    ',',
  );
  assert.equal(parseDirectory(many).probes.length, 512);
});

test('the path of a device from its id', () => {
  assert.equal(pathOf('28-4AEC29CDBAAB'), '/28.4AEC29CDBAAB');
});

test('temperatures: strict numbers, the range of the probes, never text as 0', () => {
  assert.deepEqual(parseValues('28', '     21.5625'), {
    values: [['temperature', 21.56]],
    raw: 21.5625,
  });
  assert.deepEqual(parseValues('28', '-10.125').values, [['temperature', -10.13]]);
  assert.deepEqual(parseValues('26', ' 0').values, [['temperature', 0]]);
  // The bounds of the probes are values.
  assert.deepEqual(parseValues('28', '-55').values, [['temperature', -55]]);
  assert.deepEqual(parseValues('28', '125').values, [['temperature', 125]]);
  // 84.996 rounds to 85 but is not the power-on value.
  assert.equal(parseValues('28', '84.996').raw, 84.996);
  for (const bad of ['', '   ', 'abc', '1e2', '0x10', '21,5', '- 3', '21.', '.5', 'NaN', '1234']) {
    assert.deepEqual(parseValues('28', bad), { error: 'unreadable' }, JSON.stringify(bad));
  }
  assert.deepEqual(parseValues('28', '125.5'), { error: 'out_of_range' });
  assert.deepEqual(parseValues('28', '-55.1'), { error: 'out_of_range' });
  assert.deepEqual(parseValues('28', undefined), { error: 'unreadable' });
  assert.deepEqual(parseValues('20', '1'), { error: 'unreadable' });
});

test('counters: two integers of 32 bits, never a decimal nor a negative', () => {
  assert.deepEqual(parseValues('1D', '         206,         208'), {
    values: [
      ['counter_a', 206],
      ['counter_b', 208],
    ],
  });
  assert.deepEqual(parseValues('1D', '4294967295,0'), {
    values: [
      ['counter_a', 4294967295],
      ['counter_b', 0],
    ],
  });
  assert.deepEqual(parseValues('1D', '4294967296,0'), { error: 'out_of_range' });
  for (const bad of ['1.5,2', '-1,2', '1,,2', '1,2,3', '', 'a,b', ' ,1']) {
    assert.deepEqual(parseValues('1D', bad), { error: 'unreadable' }, bad);
  }
});

test('inputs: 0 or 1 only, a single channel DS2406 taken in order', () => {
  assert.deepEqual(parseValues('29', '0,1,1,1,0,0,0,1').values.length, 8);
  assert.deepEqual(parseValues('12', '1,0'), {
    values: [
      ['input_a', 1],
      ['input_b', 0],
    ],
  });
  assert.deepEqual(parseValues('12', '1'), { values: [['input_a', 1]] });
  assert.deepEqual(parseValues('05', '0'), { values: [['input', 0]] });
  for (const bad of ['2,0', '1,0,1', 'yes', '', '1.0,0']) {
    assert.deepEqual(parseValues('12', bad), { error: 'unreadable' }, bad);
  }
});

test('85 °C is the power-on value of the DS18x20 family only', () => {
  assert.equal(isPowerOnValue('28', 85), true);
  assert.equal(isPowerOnValue('10', 85), true);
  for (const code of ['22', '3B', '42']) assert.equal(isPowerOnValue(code, 85), true, code);
  assert.equal(isPowerOnValue('28', 84.996), false);
  assert.equal(isPowerOnValue('28', 85.06), false);
  assert.equal(isPowerOnValue('26', 85), false);
});

test('the feature keys are the forever ones', () => {
  assert.deepEqual([...KNOWN_KEYS].sort(), [
    'counter_a',
    'counter_b',
    'input',
    'input_0',
    'input_1',
    'input_2',
    'input_3',
    'input_4',
    'input_5',
    'input_6',
    'input_7',
    'input_a',
    'input_b',
    'temperature',
  ]);
  for (const [code, family] of Object.entries(FAMILIES)) {
    assert.match(code, /^[0-9A-F]{2}$/);
    assert.ok(family.read.path && !family.read.path.includes('/'), code);
  }
});
