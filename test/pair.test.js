import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTOCOL_KEY,
  discoveryRequest,
  parseAnswer,
  scramble,
  unscramble,
} from '../scripts/pair.mjs';

test('AES-128-CTR as PySrDaliGateway (vectors from openssl)', () => {
  assert.equal(scramble('discover', PROTOCOL_KEY), '877860c5412e167c');
  assert.equal(scramble('admin', PROTOCOL_KEY), '82757ecf40');
  assert.equal(unscramble('82757ecf40', PROTOCOL_KEY), 'admin');
  assert.equal(unscramble('zz', PROTOCOL_KEY), undefined);
});

test('the discovery request: a random key, then "discover" under it, under the protocol key', () => {
  const json = JSON.parse(discoveryRequest('A1B2').toString());
  assert.equal(json.type, 'HA');
  assert.deepEqual(json.snList, ['A1B2']);
  const inner = unscramble(json.cmd, PROTOCOL_KEY);
  assert.equal(inner.length, 16 + 16);
  assert.equal(unscramble(inner.slice(16), inner.slice(0, 16)), 'discover');
});

test('an answer gives the credentials; a bad one gives nothing', () => {
  const answer = parseAnswer(
    Buffer.from(
      JSON.stringify({
        data: {
          gwSn: 'A1B2C3D4E5F6',
          gwIp: '192.168.1.70',
          port: 1883,
          name: 'Gateway',
          username: scramble('user', PROTOCOL_KEY),
          passwd: scramble('pass', PROTOCOL_KEY),
          isMqttTls: false,
        },
      }),
    ),
  );
  assert.deepEqual(answer, {
    serial: 'A1B2C3D4E5F6',
    name: 'Gateway',
    ip: '192.168.1.70',
    port: 1883,
    tls: false,
    username: 'user',
    password: 'pass',
  });
  assert.equal(parseAnswer(Buffer.from('{"data":{"gwSn":"a/b"}}')), undefined);
  assert.equal(parseAnswer(Buffer.alloc(5000)), undefined);
  assert.equal(parseAnswer(Buffer.from('nope')), undefined);
});

test('a port given as text is taken, as the reference does', () => {
  const answer = parseAnswer(
    Buffer.from(JSON.stringify({ data: { gwSn: 'A1B2C3D4E5F6', port: '8883' } })),
  );
  assert.equal(answer.port, 8883);
  assert.equal(
    parseAnswer(Buffer.from(JSON.stringify({ data: { gwSn: 'A1B2C3D4E5F6', port: '70000' } })))
      .port,
    undefined,
  );
});
