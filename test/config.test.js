import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeConfig,
  normalizeFingerprint,
  normalizeSerial,
  parseHost,
  placeKey,
  sessionKey,
} from '../src/config.js';
import { normalizeMemory } from '../src/store.js';

test('host: an address or a name only', () => {
  assert.equal(parseHost(' 192.168.1.70 '), '192.168.1.70');
  assert.equal(parseHost('dali.lan'), 'dali.lan');
  assert.equal(parseHost('fe80::1'), 'fe80::1');
  for (const bad of ['http://1.2.3.4', '1.2.3.4:1883', 'a b', '-x', '1.2.3.4/x', '']) {
    assert.equal(parseHost(bad), '', bad);
  }
});

test('serial number: a MAC is joined in capitals; no topic character passes', () => {
  assert.equal(normalizeSerial('a1:b2:c3:d4:e5:f6'), 'A1B2C3D4E5F6');
  assert.equal(normalizeSerial('A1B2C3D4E5F6'), 'A1B2C3D4E5F6');
  for (const bad of ['A1/B2', 'A1+B2C3', '#', 'abc', 'A1B2\nC3', '']) {
    assert.equal(normalizeSerial(bad), '', JSON.stringify(bad));
  }
});

test('fingerprint: any common writing', () => {
  const hex = 'ab'.repeat(32);
  assert.equal(normalizeFingerprint(`SHA256: ${hex.match(/../g).join(':').toUpperCase()}`), hex);
  assert.equal(normalizeFingerprint('abcd'), '');
});

test('the configuration, with defaults and the keys of a session', () => {
  const config = normalizeConfig({
    host: '10.0.0.5',
    port: '8883',
    serial_number: 'A1B2C3D4E5F6',
    username: ' user ',
    password: ' p w ',
    tls: true,
    language: 'EN',
  });
  assert.equal(config.port, 8883);
  assert.equal(config.username, 'user');
  assert.equal(config.password, ' p w ', 'a password is kept as typed');
  assert.equal(config.language, 'en');
  assert.equal(placeKey(config), 'tls://10.0.0.5:8883/A1B2C3D4E5F6');
  assert.ok(!placeKey(config).includes('p w'), 'no credential in the place');
  assert.notEqual(sessionKey(config), sessionKey({ ...config, password: 'other' }));
  const defaults = normalizeConfig({ port: '', password: 'a\u0000b' });
  assert.equal(defaults.port, 1883);
  assert.equal(defaults.tls, false);
  assert.equal(defaults.password, '');
  assert.equal(defaults.passwordInvalid, true);
});

test('the memory of /data is repaired, never trusted', () => {
  assert.deepEqual(normalizeMemory(null), { stop: null, pin: null, lastAttemptAt: 0 });
  const memory = normalizeMemory({
    stop: { place: 'x', kind: 'credentials_refused', at: 5, presented: 'nothex' },
    pin: { place: 'A1', fingerprint: 'zz' },
    lastAttemptAt: 'soon',
    password: 'never',
  });
  assert.deepEqual(memory, {
    stop: { place: 'x', kind: 'credentials_refused', at: 5 },
    pin: null,
    lastAttemptAt: 0,
  });
  assert.equal(normalizeMemory({ stop: { place: 'x', kind: 'other' } }).stop, null);
});
