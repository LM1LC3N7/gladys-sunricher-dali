import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { MqttSession } from '../src/mqtt/client.js';
import {
  FakeGateway,
  OTHER_CERT,
  SERIAL,
  TEST_CA,
  TEST_CERT,
  publishFrame,
} from './helpers/fakeGateway.js';
import { SUNRICHER_CA } from '../src/mqtt/client.js';
import { silentLogger, sleep, until } from './helpers/wait.js';

const TOPIC = `/${SERIAL}/client/reciver/`;

function session(gateway, extra = {}, { ca = TEST_CA } = {}) {
  const logger = silentLogger();
  const s = new MqttSession({ logger, ca });
  s.configure({
    host: '127.0.0.1',
    port: gateway.port,
    tls: gateway.tls,
    username: 'dali-user',
    password: 'dali-pass',
    fingerprint: '',
    topic: TOPIC,
    publishTopic: `/${SERIAL}/server/publish/`,
    ...extra,
  });
  const events = [];
  for (const name of ['up', 'down', 'message', 'attempt'])
    s.on(name, (e) => events.push([name, e]));
  return { s, events, logger };
}

test('connects, subscribes to the exact topic, takes only its messages', async (t) => {
  const gateway = await new FakeGateway().listen();
  const { s, events, logger } = session(gateway);
  t.after(async () => {
    s.stop();
    await gateway.close();
  });
  s.start();
  await until(() => s.connected);
  assert.equal(gateway.topic, TOPIC);
  assert.equal(gateway.connects[0].username, 'dali-user');
  assert.match(gateway.connects[0].clientId, /^gladys_dali_[0-9a-f]{12}$/);
  gateway.push({ cmd: 'a' });
  gateway.push({ cmd: 'b' }, `/OTHER/client/reciver/`);
  gateway.push({ cmd: 'c' }, `/${SERIAL}/client/#`);
  await until(() => events.some(([n]) => n === 'message'));
  await sleep(50);
  const messages = events
    .filter(([n]) => n === 'message')
    .map(([, e]) => JSON.parse(e.payload).cmd);
  assert.deepEqual(messages, ['a']);
  assert.ok(s.publish('{"cmd":"x"}'));
  await until(() => gateway.published.length === 1);
  assert.equal(gateway.connections, 1, 'one session only');
  assert.ok(!logger.lines.some((l) => l.includes('dali-pass')), 'the password is never logged');
});

test('a CONNACK 5 (not authorized) is final: no new try', async (t) => {
  const gateway = await new FakeGateway({ password: 'other' }).listen();
  const { s, events } = session(gateway);
  t.after(async () => {
    s.stop();
    await gateway.close();
  });
  s.start();
  const [, down] = await until(() => events.find(([n]) => n === 'down'));
  assert.equal(down.refused, true);
  assert.equal(down.retryIn, undefined);
  assert.equal(s.running, false);
  await sleep(100);
  assert.equal(gateway.connections, 1);
});

test('two sessions in a row closed right after CONNECT: final', async (t) => {
  const gateway = await new FakeGateway({ connack: 'close' }).listen();
  const timers = {
    setTimeout: (fn, ms) => setTimeout(fn, ms >= 10_000 ? 5 : ms),
    clearTimeout,
    setInterval,
    clearInterval,
  };
  const s = new MqttSession({ timers });
  s.configure({
    host: '127.0.0.1',
    port: gateway.port,
    username: 'u',
    password: 'p',
    topic: TOPIC,
    publishTopic: '/x/',
  });
  const downs = [];
  s.on('down', (e) => downs.push(e));
  t.after(async () => {
    s.stop();
    await gateway.close();
  });
  s.start();
  await until(() => downs.length === 2);
  assert.equal(downs[0].silent, false);
  assert.ok(downs[0].retryIn > 0);
  assert.equal(downs[1].silent, true);
  assert.equal(downs[1].retryIn, undefined);
  await sleep(50);
  assert.equal(gateway.connections, 2);
});

test('TLS: the certificate is learnt (kept) before CONNECT, then pinned', async (t) => {
  const gateway = await new FakeGateway({ tls: true }).listen();
  const { s } = session(gateway);
  const order = [];
  s.learn = async (fingerprint) => {
    order.push(['learn', fingerprint, gateway.connects.length]);
    await sleep(30);
    return true;
  };
  t.after(async () => {
    s.stop();
    await gateway.close();
  });
  s.start();
  await until(() => s.connected);
  assert.equal(order.length, 1);
  assert.match(order[0][1], /^[0-9a-f]{64}$/);
  assert.equal(order[0][2], 0, 'no CONNECT before the pin is kept');
  assert.equal(s.options.fingerprint, order[0][1]);
});

test('TLS: another certificate than the pinned one gets no password, no new try', async (t) => {
  const gateway = await new FakeGateway({ tls: true, cert: OTHER_CERT }).listen();
  const { s, events } = session(gateway, { fingerprint: 'a'.repeat(64) });
  t.after(async () => {
    s.stop();
    await gateway.close();
  });
  s.start();
  const [, down] = await until(() => events.find(([n]) => n === 'down'));
  assert.equal(down.certificate, true);
  assert.match(down.presented, /^[0-9a-f]{64}$/);
  await sleep(50);
  assert.equal(gateway.connects.length, 0, 'CONNECT (with the password) never written');
  assert.equal(s.running, false);
});

test('TLS: a pin that cannot be kept stops before CONNECT', async (t) => {
  const gateway = await new FakeGateway({ tls: true }).listen();
  const { s, events } = session(gateway);
  s.learn = async () => false;
  t.after(async () => {
    s.stop();
    await gateway.close();
  });
  s.start();
  await until(() => events.find(([n]) => n === 'down'));
  assert.equal(gateway.connects.length, 0);
});

test('an oversized packet ends the session; a later packet of it is never taken', async (t) => {
  const sockets = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => undefined);
    socket.once('data', () => {
      socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00]));
      socket.once('data', () => {
        socket.write(Buffer.from([0x90, 0x03, 0x00, 0x01, 0x00]));
        // 1 MB announced: over the bound.
        socket.write(Buffer.from([0x30, 0x80, 0x80, 0x40]));
        socket.write(publishFrame(TOPIC, '{"cmd":"late"}'));
      });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const s = new MqttSession();
  s.configure({
    host: '127.0.0.1',
    port: server.address().port,
    username: 'u',
    password: 'p',
    topic: TOPIC,
    publishTopic: '/x/',
  });
  const events = [];
  s.on('down', (e) => events.push(['down', e]));
  s.on('message', (e) => events.push(['message', e]));
  t.after(async () => {
    s.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  s.start();
  const [, down] = await until(() => events.find(([n]) => n === 'down'));
  assert.match(down.reason, /too large/);
  assert.ok(!events.some(([n]) => n === 'message'));
});

test('TLS first contact: a certificate not signed by the root gets nothing, no new try', async (t) => {
  for (const [cert, ca] of [
    [TEST_CERT, TEST_CA], // self-signed
    [undefined, SUNRICHER_CA], // signed by another root than Sunricher's
  ]) {
    const gateway = await new FakeGateway({ tls: true, ...(cert ? { cert } : {}) }).listen();
    const { s, events } = session(gateway, {}, { ca });
    let learnt = 0;
    s.learn = async () => {
      learnt += 1;
      return true;
    };
    t.after(async () => {
      s.stop();
      await gateway.close();
    });
    s.start();
    const [, down] = await until(() => events.find(([n]) => n === 'down'));
    assert.equal(down.untrusted, true);
    assert.match(down.presented, /^[0-9a-f]{64}$/);
    await sleep(50);
    assert.equal(gateway.connects.length, 0);
    assert.equal(learnt, 0);
    assert.equal(s.running, false);
  }
});

test('TLS: a typed (pinned) fingerprint is accepted even when Sunricher did not sign it', async (t) => {
  const probe = await new FakeGateway({ tls: true, cert: TEST_CERT }).listen();
  const first = session(probe, {}, { ca: TEST_CA });
  first.s.start();
  const [, down] = await until(() => first.events.find(([n]) => n === 'down'));
  await probe.close();
  const gateway = await new FakeGateway({ tls: true, cert: TEST_CERT }).listen();
  const { s } = session(gateway, { fingerprint: down.presented }, { ca: TEST_CA });
  t.after(async () => {
    s.stop();
    await gateway.close();
  });
  s.start();
  await until(() => s.connected);
  assert.equal(gateway.connects.length, 1);
});

test('a protocol error before CONNACK is an ordinary cut, never a refusal', async (t) => {
  const sockets = [];
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    sockets.push(socket);
    socket.on('error', () => undefined);
    // A PUBLISH before the CONNACK.
    socket.once('data', () => socket.write(publishFrame(TOPIC, '{}')));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const timers = {
    setTimeout: (fn, ms) => setTimeout(fn, ms >= 10_000 ? 5 : ms),
    clearTimeout,
    setInterval,
    clearInterval,
  };
  const s = new MqttSession({ timers });
  s.configure({
    host: '127.0.0.1',
    port: server.address().port,
    username: 'u',
    password: 'p',
    topic: TOPIC,
    publishTopic: '/x/',
  });
  const downs = [];
  s.on('down', (e) => downs.push(e));
  t.after(async () => {
    s.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  s.start();
  await until(() => downs.length >= 3);
  assert.ok(downs.every((d) => !d.silent && !d.refused && d.retryIn > 0));
  assert.ok(connections >= 3);
});

test('prepare() is awaited before the connection opens', async (t) => {
  const gateway = await new FakeGateway().listen();
  const { s } = session(gateway);
  const seen = [];
  s.prepare = async () => {
    await sleep(40);
    seen.push(gateway.connections);
  };
  t.after(async () => {
    s.stop();
    await gateway.close();
  });
  s.start();
  assert.equal(s.busy, true, 'busy while preparing');
  await until(() => s.connected);
  assert.deepEqual(seen, [0]);
});

test('a full write buffer: nothing written, the session cut', () => {
  const s = new MqttSession();
  const writes = [];
  s.socket = {
    writableLength: 10 * 1024 * 1024,
    write: (b) => writes.push(b),
    removeAllListeners() {},
    on() {},
    destroy() {},
  };
  s.ready = true;
  s.running = false;
  assert.equal(s.publish('{}'), false);
  assert.equal(writes.length, 0);
});
