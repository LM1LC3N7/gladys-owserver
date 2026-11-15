// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ACTIONS, DEFAULT_INTERVAL_SECONDS, INTERVAL_CHOICES } from '../src/constants.js';
import { buildDevice } from '../src/devices.js';
import { FAMILIES } from '../src/owserver/families.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const index = read('index.js');
const dockerfile = read('Dockerfile');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

const fakeGladys = {
  externalIds: (type, id) => ({
    device: `ext:owserver:${type}:${id}`,
    feature: (key) => `ext:owserver:${type}:${id}:${key}`,
  }),
};
const allDevices = () =>
  Object.keys(FAMILIES).map((family) =>
    buildDevice(fakeGladys, { id: `${family}-000000000001`, family }, '192.168.1.30'),
  );

test('the store basics; one version everywhere, never pinned', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-owserver:${manifest.version}`);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(pkg.name, 'gladys-owserver');
  assert.equal(pkg.license, 'Apache-2.0');
  assert.match(pkg.dependencies['@gladysassistant/integration-sdk'], /^\^0\.16\.\d+$/);
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  assert.deepEqual(manifest.categories, ['protocols']);
  assert.deepEqual(manifest.transports, ['local']);
  assert.equal(manifest.gladys_version, '>=5.1.0');
  assert.equal(manifest.countries, undefined, 'the whole world');
  assert.equal(manifest.keywords, undefined);
  assert.match(
    manifest.cover_image,
    /^https:\/\/raw\.githubusercontent\.com\/LM1LC3N7\/gladys-owserver\//,
  );
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(manifest.description.en, /Unofficial/);
  assert.match(manifest.description.fr, /Non officiel/);
});

test('the cover is an 800 x 534 PNG', () => {
  const png = readFileSync(new URL('../cover.png', import.meta.url));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 800);
  assert.equal(png.readUInt32BE(20), 534);
});

test('the docs say it was never tested with a real 1-Wire bus', () => {
  assert.match(read('docs/fr.md'), /[Jj]amais\s+testé\s+avec\s+un\s+vrai\s+bus\s+1-Wire/);
  assert.match(read('docs/en.md'), /[Nn]ever\s+tested\s+with\s+a\s+real\s+1-Wire\s+bus/);
  assert.match(read('README.md'), /[Nn]ever\s+tested\s+with\s+a\s+real\s+1-Wire\s+bus/);
});

test('every text is in English and French; placeholders too', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
  }
  for (const field of manifest.config_schema) {
    if ('placeholder' in field) assert.equal(typeof field.placeholder, 'object', field.key);
  }
});

test('the configuration matches the code: an address, an interval; no gladys_ key', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  assert.deepEqual(Object.keys(fields), ['intro', 'address', 'interval_seconds']);
  for (const key of Object.keys(fields)) assert.ok(!key.startsWith('gladys_'), key);
  assert.equal(fields.address.type, 'string');
  assert.equal(fields.address.required, true);
  assert.equal(fields.interval_seconds.type, 'select');
  assert.equal(fields.interval_seconds.default, String(DEFAULT_INTERVAL_SECONDS));
  assert.deepEqual(
    fields.interval_seconds.options.map((o) => Number(o.value)),
    INTERVAL_CHOICES,
  );
  assert.ok(!manifest.config_schema.some((f) => f.type === 'secret'), 'owserver has no login');
  for (const link of fields.intro.links) assert.match(link.url, /^https:\/\//);
});

test('the select options follow the rules of the core', () => {
  const field = manifest.config_schema.find((f) => f.key === 'interval_seconds');
  const values = field.options.map((o) => o.value);
  assert.equal(new Set(values).size, values.length);
  for (const option of field.options) {
    assert.deepEqual(Object.keys(option).sort(), ['label', 'value']);
    assert.equal(typeof option.value, 'string');
    for (const lang of ['en', 'fr']) {
      assert.equal(typeof option.label[lang], 'string');
      assert.equal(option.label[lang], option.label[lang].trim());
      assert.ok(option.label[lang].length > 0);
    }
  }
});

test('no feature publishes supported_options (checked against the core when cloned)', () => {
  const features = allDevices().flatMap((d) => d.features);
  for (const f of features) assert.equal(f.supported_options, undefined, f.external_id);
  const core = `${process.env.HOME}/code/Gladys/server/utils/normalizeSupportedOptions.js`;
  if (existsSync(core)) {
    const require = createRequire(import.meta.url);
    const mod = require(core);
    assert.equal(typeof mod.normalizeSupportedOptions, 'function');
  }
});

test('the actions of the manifest are the handlers of the code; read-only', () => {
  assert.deepEqual(
    manifest.actions.map((a) => a.key),
    Object.values(ACTIONS),
  );
  assert.ok(index.includes('onAction(ACTIONS.TEST'));
  assert.ok(index.includes('onAction(ACTIONS.ACCEPT_COUNTERS'));
  assert.ok(index.includes("on('connected'"));
  assert.ok(!index.includes('onSetValue'), 'no command: read-only');
  const client = read('src/owserver/client.js') + read('src/owserver/protocol.js');
  const code = client.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/MSG\.WRITE|\bWRITE\b|: 3[,}]/.test(code), 'never a WRITE message');
  assert.ok(!code.includes('logger'));
});

test('the devices: core units only, read-only, never a switch', () => {
  for (const device of allDevices()) {
    for (const f of device.features) {
      assert.equal(f.read_only, true, f.external_id);
      assert.notEqual(f.category, 'switch');
      // DEVICE_FEATURE_UNITS_BY_CATEGORY of the core (server/utils/constants.js).
      const units = {
        'temperature-sensor': ['celsius'],
        'counter-sensor': [undefined],
        'opening-sensor': [undefined],
      };
      assert.ok(units[f.category]?.includes(f.unit), `${f.external_id} ${f.category} ${f.unit}`);
      assert.ok(!f.external_id.slice('ext:owserver:'.length).includes('.'), 'no dot in an id');
    }
  }
});

test('the licenses ship in the image; no name in LICENSE', () => {
  assert.match(dockerfile, /COPY LICENSE THIRD_PARTY_NOTICES\.md/);
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /General Public License 2\.0/);
  assert.match(notices, /No OWFS\s+code is copied/);
});

test('the code never feeds the energy consumption endpoint nor scene events', () => {
  for (const file of ['index.js', 'src/app.js', 'src/devices.js']) {
    assert.doesNotMatch(read(file), /publishEnergyConsumption\(/, file);
    assert.doesNotMatch(read(file), /publishSceneEvent\(/, file);
  }
});
