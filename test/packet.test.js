import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PacketReader, TYPE, connect, publish, subscribe } from '../src/mqtt/packet.js';
import { publishFrame } from './helpers/fakeGateway.js';

const collect = (maxPacket = 1024) => {
  const packets = [];
  const errors = [];
  const reader = new PacketReader({
    maxPacket,
    onPacket: (p) => packets.push(p),
    onError: (e) => errors.push(e),
  });
  return { reader, packets, errors };
};

test('CONNECT carries the user name and password only when given', () => {
  const withCredentials = connect({ clientId: 'c', username: 'u', password: 'p', keepAlive: 60 });
  assert.equal(withCredentials[0], 0x10);
  assert.equal(withCredentials[9] & 0xc2, 0xc2, 'user name, password and clean session flags');
  const bare = connect({ clientId: 'c', keepAlive: 60 });
  assert.equal(bare[9], 0x02);
});

test('SUBSCRIBE and PUBLISH have the right fixed headers', () => {
  assert.equal(subscribe(1, '/a/')[0], 0x82);
  const packet = publish('/t/', '{"a":1}');
  assert.equal(packet[0], 0x30);
  assert.equal(packet[1], 2 + 3 + 7);
});

test('the reader cuts packets across chunks, byte by byte', () => {
  const { reader, packets } = collect();
  const bytes = Buffer.concat([
    Buffer.from([0x20, 0x02, 0x00, 0x00]),
    publishFrame('/x/', 'hello'),
    Buffer.from([0xd0, 0x00]),
  ]);
  for (const byte of bytes) reader.push(Buffer.from([byte]));
  assert.deepEqual(
    packets.map((p) => p.type),
    [TYPE.CONNACK, TYPE.PUBLISH, TYPE.PINGRESP],
  );
  assert.equal(packets[1].topic, '/x/');
  assert.equal(packets[1].payload.toString(), 'hello');
});

test('QoS 1 publishes carry their packet id', () => {
  const { reader, packets } = collect();
  reader.push(publishFrame('/x/', 'a', { qos: 1, packetId: 7 }));
  assert.equal(packets[0].qos, 1);
  assert.equal(packets[0].packetId, 7);
});

test('a packet over the bound, a bad length or a malformed packet is an error', () => {
  const big = collect(16);
  big.reader.push(publishFrame('/x/', 'a'.repeat(40)));
  assert.match(big.errors[0].message, /too large/);
  big.reader.push(Buffer.from([0xd0, 0x00]));
  assert.equal(big.packets.length, 0, 'nothing after an error');

  const length = collect();
  length.reader.push(Buffer.from([0x30, 0xff, 0xff, 0xff, 0xff, 0x01]));
  assert.match(length.errors[0].message, /length/);

  const broken = collect();
  broken.reader.push(Buffer.from([0x20, 0x01, 0x00]));
  assert.match(broken.errors[0].message, /CONNACK/);

  const unexpected = collect();
  unexpected.reader.push(Buffer.from([0x10, 0x00]));
  assert.match(unexpected.errors[0].message, /unexpected/);
});
