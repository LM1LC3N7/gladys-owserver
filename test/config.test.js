import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressText, isComplete, normalizeConfig, parseAddress } from '../src/config.js';

test('addresses: host and port, 4304 by default, a pasted URL reduced', () => {
  assert.deepEqual(parseAddress('192.168.1.30'), { host: '192.168.1.30', port: 4304 });
  assert.deepEqual(parseAddress(' 192.168.1.30:4305 '), { host: '192.168.1.30', port: 4305 });
  assert.deepEqual(parseAddress('owserver://Pi.local:4304/'), { host: 'pi.local', port: 4304 });
  assert.deepEqual(parseAddress('[fe80::1]:4304'), { host: 'fe80::1', port: 4304 });
  assert.deepEqual(parseAddress('fd00::12'), { host: 'fd00::12', port: 4304 });
  assert.deepEqual(parseAddress('raspberrypi'), { host: 'raspberrypi', port: 4304 });
  assert.deepEqual(parseAddress('10.0.0.2:65535'), { host: '10.0.0.2', port: 65535 });
  assert.deepEqual(parseAddress(''), { empty: true });
});

test('addresses that are never one server, or not an address, are refused', () => {
  for (const bad of [
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.1',
    '239.1.2.3',
    '192.168.1.300',
    '1.2.3',
    '[::]',
    'ff02::1',
    'user:pw@192.168.1.30',
    '192.168.1.30:0',
    '192.168.1.30:70000',
    '192.168.1.30:65536',
    'bad host',
    'a\r\nb',
    'x'.repeat(301),
    '-pi.local',
  ]) {
    assert.deepEqual(parseAddress(bad), { error: 'invalid' }, bad);
  }
});

test('the configuration: interval among the choices, the default otherwise', () => {
  assert.equal(normalizeConfig({ address: '10.0.0.2' }).intervalSeconds, 60);
  assert.equal(
    normalizeConfig({ address: '10.0.0.2', interval_seconds: '300' }).intervalSeconds,
    300,
  );
  assert.equal(normalizeConfig({ address: '10.0.0.2', interval_seconds: 30 }).intervalSeconds, 30);
  assert.equal(normalizeConfig({ address: '10.0.0.2', interval_seconds: '5' }).intervalSeconds, 60);
  assert.equal(normalizeConfig({ address: '10.0.0.2', interval_seconds: 'x' }).intervalSeconds, 60);
  const bad = normalizeConfig({ address: '0.0.0.0' });
  assert.equal(bad.invalidAddress, true);
  assert.equal(isComplete(bad), false);
  assert.equal(isComplete(normalizeConfig({})), false);
  assert.equal(normalizeConfig({}).invalidAddress, false);
  assert.equal(normalizeConfig({ gladys_address: '10.0.0.2' }).host, '');
});

test('the address shown: the port only when it is not 4304', () => {
  assert.equal(addressText(normalizeConfig({ address: '10.0.0.2' })), '10.0.0.2');
  assert.equal(addressText(normalizeConfig({ address: '10.0.0.2:5000' })), '10.0.0.2:5000');
  assert.equal(addressText(normalizeConfig({ address: 'fd00::1' })), '[fd00::1]');
});
