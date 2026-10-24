import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  brightnessProperty,
  colorProperty,
  hsvToColor,
  integer,
  message,
  parseIlluminance,
  parseLight,
  parseMessage,
  parseMotion,
  parsePanel,
  publishTopic,
  subscribeTopic,
  temperatureProperty,
} from '../src/dali/protocol.js';

const SN = 'A1B2C3D4E5F6';
const parse = (object) => parseMessage(Buffer.from(JSON.stringify(object)), SN);

test('the topics of PySrDaliGateway, spelling included', () => {
  assert.equal(subscribeTopic(SN), `/${SN}/client/reciver/`);
  assert.equal(publishTopic(SN), `/${SN}/server/publish/`);
});

test('the envelope of a command', () => {
  const json = JSON.parse(message(SN, 'writeScene', { channel: 0, sceneId: 2 }, 1_700_000_000_500));
  assert.deepEqual(json, {
    cmd: 'writeScene',
    msgId: '1700000000',
    gwSn: SN,
    channel: 0,
    sceneId: 2,
  });
});

test('strict integers: an empty text, a decimal or a sign is not a number', () => {
  assert.equal(integer('', 0, 63), undefined);
  assert.equal(integer(' 3', 0, 63), undefined);
  assert.equal(integer('3', 0, 63), 3);
  assert.equal(integer(1.5, 0, 63), undefined);
  assert.equal(integer(64, 0, 63), undefined);
  assert.equal(integer(null, 0, 63), undefined);
});

test('a message of another gateway, not JSON or without command is ignored', () => {
  assert.ok(parse({ cmd: 'devStatus', gwSn: 'OTHER', data: {} }).ignored);
  assert.ok(parseMessage(Buffer.from('{oops'), SN).ignored);
  assert.ok(parse([1, 2]).ignored);
  assert.ok(parse({ gwSn: SN }).ignored);
  assert.ok(parse({ cmd: 'x'.repeat(41) }).ignored);
  assert.ok(parse({ cmd: 'restartGatewayRes', gwSn: SN }).ignored);
});

test('a device status needs a valid type, bus and address', () => {
  const ok = parse({
    cmd: 'devStatus',
    gwSn: SN,
    data: { devType: '0101', channel: 0, address: 5, property: [] },
  });
  assert.deepEqual(ok.ref, { devType: '0101', channel: 0, address: 5 });
  for (const data of [
    { devType: '01', channel: 0, address: 5 },
    { devType: '0101', channel: '', address: 5 },
    { devType: '0101', channel: 0, address: 64 },
    { devType: '0101', channel: 16, address: 1 },
    { devType: '../x', channel: 0, address: 1 },
  ]) {
    assert.ok(parse({ cmd: 'devStatus', gwSn: SN, data }).ignored, JSON.stringify(data));
  }
});

test('light status: only the values present and valid', () => {
  assert.deepEqual(
    parseLight([
      { dpid: 20, value: 1 },
      { dpid: 22, value: 500 },
      { dpid: 23, value: 3000 },
      { dpid: 24, value: '00000000' },
    ]),
    { on: true, brightness: 500, kelvin: 3000, color: 0xffffff },
  );
  assert.deepEqual(parseLight([{ id: 20, value: false }]), { on: false });
  assert.deepEqual(
    parseLight([
      { dpid: 20, value: 'maybe' },
      { dpid: 22, value: 2000 },
      { dpid: 22, value: '' },
      { dpid: 23, value: 50 },
      { dpid: 24, value: 'zz' },
      'junk',
      null,
    ]),
    {},
  );
});

test('colours: HSV text <-> Gladys integer', () => {
  assert.equal(hsvToColor('000003e8'), 0xff0000);
  assert.equal(hsvToColor('007803e803e8'), 0x00ff00);
  assert.equal(hsvToColor('00f003e8'), 0x0000ff);
  assert.equal(hsvToColor('xyz'), undefined);
  assert.equal(colorProperty(0xff0000).value, '000003e803e8');
  assert.equal(colorProperty(0x0000ff).value, '00f003e803e8');
  assert.equal(colorProperty(0xffffff).value, '0000000003e8');
  assert.deepEqual(brightnessProperty(55), { dpid: 22, dataType: 'uint16', value: 550 });
  assert.deepEqual(temperatureProperty(250), { dpid: 23, dataType: 'uint16', value: 4000 });
});

test('motion, illuminance and panels', () => {
  assert.deepEqual(parseMotion([{ dpid: 2 }, { dpid: 9 }, { dpid: 3 }]), ['motion', 'vacant']);
  assert.equal(parseIlluminance([{ dpid: 4, value: 230.5 }]), 230.5);
  assert.equal(parseIlluminance([{ dpid: 4, value: 0 }]), undefined);
  assert.equal(parseIlluminance([{ dpid: 4, value: 5000 }]), undefined);
  assert.deepEqual(
    parsePanel([
      { dpid: 1, keyNo: 2 },
      { dpid: 4, keyNo: 1, value: 3 },
      { dpid: 9, keyNo: 1 },
    ]),
    [
      { key: 2, event: 'press', rotate: null },
      { key: 1, event: 'rotate', rotate: 3 },
    ],
  );
});

test('lists: bounded, invalid entries dropped, names cleaned', () => {
  const search = parse({
    cmd: 'searchDevRes',
    gwSn: SN,
    searchStatus: 1,
    data: [
      { devType: '0101', channel: 0, address: 1, name: 'A\nB' },
      { devType: '0101', channel: 0, address: 99 },
    ],
  });
  assert.equal(search.devices.length, 1);
  assert.equal(search.devices[0].name, 'A B');
  assert.equal(search.done, true);
  assert.ok(parse({ cmd: 'searchDevRes', gwSn: SN, searchFlag: 'busDevice', data: [] }).ignored);
  const groups = parse({
    cmd: 'getGroupRes',
    gwSn: SN,
    group: [{ channel: 0, data: [{ groupId: 1, name: 'x'.repeat(200) }, { groupId: 16 }] }],
  });
  assert.equal(groups.groups.length, 1);
  assert.equal(groups.groups[0].name.length, 64);
  const proto = parse(
    JSON.parse(
      '{"cmd":"getSceneRes","scene":[{"channel":0,"data":[{"sceneId":1,"__proto__":{"x":1}}]}]}',
    ),
  );
  assert.equal(proto.scenes.length, 1);
  assert.equal({}.x, undefined);
});
