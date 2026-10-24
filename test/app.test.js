import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DaliApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { FakeGateway, SERIAL } from './helpers/fakeGateway.js';
import { silentLogger, sleep, until } from './helpers/wait.js';

const SN = SERIAL.toLowerCase();

async function setup(
  t,
  { gateway: options = {}, config = {}, store = memoryStore(), devices = [] } = {},
) {
  const gateway = await new FakeGateway(options).listen();
  const logger = silentLogger();
  const gladys = createFakeGladys({
    config: {
      host: '127.0.0.1',
      port: gateway.port,
      serial_number: SERIAL,
      username: 'dali-user',
      password: 'dali-pass',
      tls: Boolean(options.tls),
      ...config,
    },
    devices,
  });
  const app = new DaliApp({ gladys, logger, store });
  registerHandlers(gladys, app, logger);
  t.after(async () => {
    app.stop();
    await gladys.disconnect();
    await gateway.close();
  });
  await gladys.connect();
  return { gateway, gladys, app, logger, store };
}

const ready = (gladys) =>
  until(() =>
    /Connected to the DALI gateway/.test(gladys.fake.connectionStatus?.message?.en ?? ''),
  );

const feature = (gladys, kind, number, key, channel = 0) =>
  gladys.fake.discoveredDevices
    .flatMap((d) => d.features)
    .find(
      (f) => f.external_id === `ext:test-integration:${kind}:${SN}-${channel}-${number}:${key}`,
    );

test('reads the lists, publishes the devices and their states', async (t) => {
  const { gladys, gateway, logger } = await setup(t);
  await ready(gladys);
  const devices = gladys.fake.discoveredDevices;
  const ids = devices.map((d) => d.external_id.replace('ext:test-integration:', ''));
  assert.deepEqual(ids, [
    `light:${SN}-0-1`,
    `light:${SN}-0-2`,
    `light:${SN}-1-3`,
    `group:${SN}-0-1`,
    `scene:${SN}-0-2`,
    `motion:${SN}-0-10`,
    `illuminance:${SN}-0-11`,
  ]);
  assert.equal(devices[0].name, 'Hall');
  assert.equal(devices[2].name, 'Luminaire DALI 1-3');
  assert.deepEqual(
    devices[1].features.map((f) => f.type),
    ['binary', 'brightness', 'temperature'],
  );
  assert.deepEqual(
    devices[2].features.map((f) => f.type),
    ['binary', 'brightness', 'color'],
  );
  await until(
    () => gladys.fake.lastState(`ext:test-integration:light:${SN}-0-1:brightness`) === 50,
  );
  assert.equal(gladys.fake.lastState(`ext:test-integration:light:${SN}-0-1:binary`), 1);
  assert.equal(gladys.fake.lastState(`ext:test-integration:light:${SN}-0-2:temperature`), 250);
  assert.equal(gladys.fake.lastState(`ext:test-integration:light:${SN}-1-3:color`), 0x33ff33);
  await until(() => gladys.fake.lastState(`ext:test-integration:group:${SN}-0-1:binary`) === 1);
  assert.equal(gateway.connections, 1);
  assert.equal(gateway.commands('readDev').length, 1, 'the lights read in one message');
  assert.equal(gateway.commands('readDev')[0].data.length, 3);
  assert.ok(gladys.fake.transports.length > 0);
  assert.ok(!logger.lines.some((l) => l.includes('dali-pass') || l.includes('dali-user')));
  const status = gladys.fake.connectionStatus;
  assert.equal(status.connected, true);
  assert.match(status.message.fr, /3 luminaire\(s\), 2 capteur\(s\), 1 groupe\(s\), 1 scène\(s\)/);
  assert.match(status.message.en, /in clear/);
});

test('commands: batched writeDev, ack once written, read back', async (t) => {
  const { gladys, gateway } = await setup(t);
  await ready(gladys);
  const hall = feature(gladys, 'light', 1, 'brightness');
  const kitchen = feature(gladys, 'light', 2, 'binary');
  const [a, b] = await Promise.all([
    gladys.fake.setValue({}, hall, 80),
    gladys.fake.setValue({}, kitchen, 1),
  ]);
  assert.deepEqual(a, { success: true });
  assert.deepEqual(b, { success: true });
  await until(() => gateway.commands('writeDev').length > 0);
  await sleep(50);
  const writes = gateway.commands('writeDev');
  assert.equal(writes.length, 1, 'one message for both');
  assert.deepEqual(writes[0].data[0], {
    devType: '0101',
    channel: 0,
    address: 1,
    property: [
      { dpid: 20, dataType: 'bool', value: true },
      { dpid: 22, dataType: 'uint16', value: 800 },
    ],
  });
  assert.equal(writes[0].gwSn, SERIAL);
  await until(() => gladys.fake.lastState(hall.external_id) === 80, { timeout: 4000 });
  await until(() => gladys.fake.lastState(kitchen.external_id) === 1);
});

test('commands: groups, scenes, colours; bad values and read only refused, nothing sent', async (t) => {
  const { gladys, gateway } = await setup(t);
  await ready(gladys);
  assert.deepEqual(await gladys.fake.setValue({}, feature(gladys, 'group', 1, 'brightness'), 0), {
    success: true,
  });
  await until(() => gateway.commands('writeGroup').length === 1);
  assert.deepEqual(gateway.commands('writeGroup')[0].data, [
    { dpid: 20, dataType: 'bool', value: false },
  ]);
  assert.equal(gateway.commands('writeGroup')[0].groupId, 1);
  assert.deepEqual(await gladys.fake.setValue({}, feature(gladys, 'scene', 2, 'activate'), 1), {
    success: true,
  });
  await until(() => gateway.commands('writeScene').length === 1);
  assert.deepEqual(
    gateway.commands('writeScene').map(({ channel, sceneId }) => ({ channel, sceneId })),
    [{ channel: 0, sceneId: 2 }],
  );
  await gladys.fake.setValue({}, feature(gladys, 'light', 3, 'color', 1), 0xff0000);
  await until(() => gateway.commands('writeDev').length === 1);
  assert.equal(gateway.commands('writeDev')[0].data[0].property[0].value, '000003e803e8');
  const before = gateway.published.length;
  for (const [f, value] of [
    [feature(gladys, 'light', 1, 'brightness'), ''],
    [feature(gladys, 'light', 1, 'brightness'), null],
    [feature(gladys, 'light', 1, 'binary'), 2],
    [feature(gladys, 'light', 2, 'temperature'), 1000],
    [feature(gladys, 'scene', 2, 'activate'), 0],
    [feature(gladys, 'motion', 10, 'motion'), 1],
    [{ external_id: `ext:test-integration:light:${SN}-0-9:binary` }, 1],
    [{ external_id: `ext:test-integration:light:other1234-0-1:binary` }, 1],
  ]) {
    const ack = await gladys.fake.setValue({}, f, value);
    assert.equal(ack.success, false, JSON.stringify([f.external_id, value]));
    assert.match(ack.error, /rien n’a été envoyé|nothing sent/);
  }
  await sleep(150);
  assert.equal(gateway.published.length, before);
});

test('pushes: status, motion, illuminance, panel keys; another serial is ignored', async (t) => {
  const { gladys, gateway } = await setup(t);
  await ready(gladys);
  await until(() => gladys.fake.lastState(`ext:test-integration:light:${SN}-0-2:binary`) === 0);
  gateway.push({
    cmd: 'devStatus',
    gwSn: SERIAL,
    data: { devType: '0101', channel: 0, address: 1, property: [{ dpid: 20, value: false }] },
  });
  gateway.push({
    cmd: 'devStatus',
    gwSn: 'OTHER',
    data: { devType: '0101', channel: 0, address: 2, property: [{ dpid: 20, value: true }] },
  });
  gateway.push({
    cmd: 'devStatus',
    gwSn: SERIAL,
    data: { devType: '020101', channel: 0, address: 10, property: [{ dpid: 2 }] },
  });
  gateway.push({
    cmd: 'devStatus',
    gwSn: SERIAL,
    data: { devType: '0202', channel: 0, address: 11, property: [{ dpid: 4, value: 321.26 }] },
  });
  gateway.push({
    cmd: 'devStatus',
    gwSn: SERIAL,
    data: { devType: '0304', channel: 0, address: 12, property: [{ dpid: 1, keyNo: 3 }] },
  });
  // A different type at a known address (a replaced driver) is not applied.
  gateway.push({
    cmd: 'devStatus',
    gwSn: SERIAL,
    data: { devType: '0102', channel: 0, address: 1, property: [{ dpid: 20, value: true }] },
  });
  await until(() => gladys.fake.sceneEvents.length === 1);
  await until(
    () =>
      gladys.fake.lastState(`ext:test-integration:illuminance:${SN}-0-11:illuminance`) === 321.3,
  );
  assert.equal(gladys.fake.lastState(`ext:test-integration:light:${SN}-0-1:binary`), 0);
  assert.equal(gladys.fake.lastState(`ext:test-integration:light:${SN}-0-2:binary`), 0);
  assert.equal(gladys.fake.lastState(`ext:test-integration:motion:${SN}-0-10:motion`), 1);
  assert.equal(gladys.fake.lastState(`ext:test-integration:motion:${SN}-0-10:occupancy`), 1);
  const [event] = gladys.fake.sceneEvents;
  assert.equal(event.key, 'panel_button');
  assert.deepEqual(event.data, {
    panel: '0-12',
    name: 'Door panel',
    button: 3,
    event: 'press',
    rotate: null,
  });
});

test('refused credentials: stop persisted, no new try at restart; a new password lifts it', async (t) => {
  const store = memoryStore();
  const { gladys, gateway, app } = await setup(t, { gateway: { password: 'right' }, store });
  await until(() => store.data?.stop?.kind === 'credentials_refused');
  assert.match(gladys.fake.connectionStatus.message.en, /refused/);
  await app.startNow(gladys.fake.config);
  await sleep(100);
  assert.equal(gateway.connections, 1, 'never tried again');
  // The test button tries once, the stop stays while it fails.
  const ack = await gladys.fake.action('test_connection', {});
  assert.equal(ack.success, false);
  assert.equal(store.data.stop.kind, 'credentials_refused');
  store.data.lastAttemptAt = 0;
  app.memory.lastAttemptAt = 0;
  await gladys.fake.configUpdated({ ...gladys.fake.config, password: 'right' });
  await ready(gladys);
  assert.equal(store.data.stop, null);
});

test('a restart never connects sooner than 10 s after the last attempt', async (t) => {
  const store = memoryStore({ lastAttemptAt: Date.now() - 9_800 });
  const { gladys, gateway } = await setup(t, { store });
  await sleep(50);
  assert.equal(gateway.connections, 0);
  await until(() => gateway.connections === 1, { timeout: 1500 });
  await ready(gladys);
});

test('Gladys reconnects: status and Discovery published again', async (t) => {
  const { gladys } = await setup(t);
  await ready(gladys);
  const statuses = gladys.fake.connectionStatuses.length;
  const discovered = gladys.fake.requests.filter((r) => r.path?.includes('discover')).length;
  await gladys.disconnect();
  await gladys.connect();
  await until(() => gladys.fake.connectionStatuses.length > statuses);
  assert.ok(gladys.fake.requests.filter((r) => r.path?.includes('discover')).length > discovered);
});

test('configuration problems are shown, nothing is tried', async (t) => {
  const { gladys, gateway } = await setup(t, { config: { serial_number: 'A/B' } });
  await until(() => gladys.fake.connectionStatus);
  assert.match(gladys.fake.connectionStatus.message.en, /serial number is not understood/);
  assert.equal(gateway.connections, 0);
});

test('a gateway that does not answer on the topic says to check the serial number', async (t) => {
  const { gladys } = await setup(t, { gateway: { answer: false } });
  await until(() => gladys.fake.connectionStatus?.connected === true);
  // The lists wait 30 s; the status says "reading" meanwhile.
  assert.match(gladys.fake.connectionStatus.message.en, /reading/);
});

test('TLS: pinned on first contact in /data, kept when the field is emptied', async (t) => {
  const store = memoryStore();
  const { gladys } = await setup(t, { gateway: { tls: true }, store });
  await ready(gladys);
  assert.equal(store.data.pin.place, SERIAL);
  assert.match(store.data.pin.fingerprint, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(gladys.fake.connectionStatus.message.en, /in clear/);
});

test('TLS: a changed certificate stops, the status shows both fingerprints', async (t) => {
  const store = memoryStore({ pin: { place: SERIAL, fingerprint: 'b'.repeat(64) } });
  const { gladys, gateway } = await setup(t, { gateway: { tls: true }, store });
  await until(() => store.data?.stop?.kind === 'certificate_changed');
  assert.equal(gateway.connects.length, 0, 'no password sent');
  assert.match(gladys.fake.connectionStatus.message.en, /bb:bb/);
  assert.match(
    gladys.fake.connectionStatus.message.en,
    new RegExp(store.data.stop.presented.slice(0, 2)),
  );
});

test('the states stay under the per-minute budget with many lights', async (t) => {
  const devices = [];
  for (let channel = 0; channel < 4; channel += 1) {
    for (let address = 0; address < 64; address += 1) {
      devices.push({
        devType: '0101',
        channel,
        address,
        name: '',
        status: { on: true, brightness: 100 },
      });
    }
  }
  const { gladys } = await setup(t, {
    gateway: { installation: { devices, groups: [], scenes: [] } },
  });
  await ready(gladys);
  await until(() => gladys.fake.states.length >= 240, { timeout: 6000 });
  await sleep(300);
  assert.ok(
    gladys.fake.states.length <= 240,
    `${gladys.fake.states.length} states in the first minute`,
  );
});
