// -----------------------------------------------------------------------------
// A fake Sunricher DALI gateway for the tests: a real MQTT broker on
// 127.0.0.1 (plain TCP or TLS with a test certificate), speaking just what
// the integration uses, with a small DALI model that answers the requests
// like PySrDaliGateway expects (searchDev, getGroup, readGroup, getScene,
// readDev, writeDev, writeGroup, writeScene, getVersion).
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { TYPE } from '../../src/mqtt/packet.js';

const here = (name) => new URL(`./${name}`, import.meta.url);
export const TEST_CERT = {
  key: readFileSync(here('key.pem')),
  cert: readFileSync(here('cert.pem')),
};
/** A test root, and a gateway certificate it signed (stands for the Sunricher root). */
export const TEST_CA = readFileSync(here('test-ca.pem'));
export const SIGNED_CERT = {
  key: readFileSync(here('signed-key.pem')),
  cert: readFileSync(here('signed-cert.pem')),
};
export const OTHER_CERT = {
  key: readFileSync(here('key2.pem')),
  cert: readFileSync(here('cert2.pem')),
};

function remaining(length) {
  const bytes = [];
  let value = length;
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    bytes.push(byte);
  } while (value > 0);
  return Buffer.from(bytes);
}

const frame = (first, body) => Buffer.concat([Buffer.from([first]), remaining(body.length), body]);

function str(text) {
  const bytes = Buffer.from(text);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

export const publishFrame = (topic, payload, { qos = 0, packetId = 1 } = {}) => {
  const id = Buffer.alloc(2);
  id.writeUInt16BE(packetId);
  return frame(
    0x30 | (qos << 1),
    Buffer.concat([str(topic), ...(qos > 0 ? [id] : []), Buffer.from(payload)]),
  );
};

/** Server side: parses what a client sends (CONNECT, SUBSCRIBE, PUBLISH, PINGREQ, DISCONNECT). */
function parseClientPacket(bytes) {
  const type = bytes[0] >> 4;
  let index = 1;
  let size = 0;
  let multiplier = 1;
  for (;;) {
    const byte = bytes[index];
    size += (byte & 0x7f) * multiplier;
    multiplier *= 128;
    index += 1;
    if ((byte & 0x80) === 0) break;
  }
  const body = bytes.subarray(index, index + size);
  if (type === TYPE.CONNECT) {
    let offset = 2 + body.readUInt16BE(0); // protocol name
    offset += 1; // level
    const flags = body[offset];
    offset += 3; // flags + keep alive
    const read = () => {
      const length = body.readUInt16BE(offset);
      const value = body.subarray(offset + 2, offset + 2 + length).toString();
      offset += 2 + length;
      return value;
    };
    const clientId = read();
    const username = flags & 0x80 ? read() : undefined;
    const password = flags & 0x40 ? read() : undefined;
    return { type, clientId, username, password };
  }
  if (type === 8) {
    const packetId = body.readUInt16BE(0);
    const length = body.readUInt16BE(2);
    return { type, packetId, topic: body.subarray(4, 4 + length).toString() };
  }
  if (type === TYPE.PUBLISH) {
    const length = body.readUInt16BE(0);
    return {
      type,
      topic: body.subarray(2, 2 + length).toString(),
      payload: body.subarray(2 + length).toString(),
    };
  }
  return { type };
}

/** A tiny raw splitter for the server side (the client is trusted here). */
function splitter(onPacket) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      let index = 1;
      let size = 0;
      let multiplier = 1;
      let complete = false;
      while (index < buffer.length && index <= 4) {
        const byte = buffer[index];
        size += (byte & 0x7f) * multiplier;
        multiplier *= 128;
        index += 1;
        if ((byte & 0x80) === 0) {
          complete = true;
          break;
        }
      }
      if (!complete || buffer.length < index + size) return;
      const bytes = buffer.subarray(0, index + size);
      buffer = buffer.subarray(index + size);
      onPacket(parseClientPacket(bytes));
    }
  };
}

export const SERIAL = 'A1B2C3D4E5F6';

/** The default DALI installation of the fake gateway. */
export function defaultInstallation() {
  return {
    devices: [
      {
        devType: '0101',
        channel: 0,
        address: 1,
        name: 'Hall',
        status: { on: true, brightness: 500 },
      },
      {
        devType: '0102',
        channel: 0,
        address: 2,
        name: 'Kitchen',
        status: { on: false, brightness: 0, kelvin: 4000 },
      },
      {
        devType: '0105',
        channel: 1,
        address: 3,
        name: '',
        status: { on: true, brightness: 1000, hsv: '00780320' },
      },
      { devType: '020101', channel: 0, address: 10, name: 'Hall motion' },
      { devType: '0202', channel: 0, address: 11, name: 'Hall lux' },
      { devType: '0304', channel: 0, address: 12, name: 'Door panel' },
    ],
    groups: [{ channel: 0, groupId: 1, name: 'Ground floor', members: [1, 2] }],
    scenes: [{ channel: 0, sceneId: 2, name: 'Evening' }],
  };
}

export class FakeGateway {
  constructor({
    serial = SERIAL,
    username = 'dali-user',
    password = 'dali-pass',
    tls = false,
    cert = SIGNED_CERT,
    installation = defaultInstallation(),
    connack, // forced CONNACK code, or 'close' / 'silent'
    answer = true,
  } = {}) {
    this.serial = serial;
    this.username = username;
    this.password = password;
    this.tls = tls;
    this.installation = installation;
    this.connack = connack;
    this.answer = answer;
    this.connections = 0;
    this.connects = [];
    this.published = [];
    this.clients = new Set();
    this.subscribed = new Set();
    const handler = (socket) => this.client(socket);
    this.server = tls ? createTlsServer(cert, handler) : createServer(handler);
  }

  async listen() {
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = this.server.address().port;
    return this;
  }

  async close() {
    for (const socket of this.clients) socket.destroy();
    await new Promise((resolve) => this.server.close(resolve));
  }

  /** Every PUBLISH of the clients, decoded JSON. */
  commands(cmd) {
    return this.published.filter((p) => p.cmd === cmd);
  }

  client(socket) {
    this.connections += 1;
    this.clients.add(socket);
    socket.on('close', () => {
      this.clients.delete(socket);
      this.subscribed.delete(socket);
    });
    socket.on('error', () => undefined);
    socket.on(
      'data',
      splitter((packet) => this.packet(socket, packet)),
    );
  }

  packet(socket, packet) {
    if (packet.type === TYPE.CONNECT) {
      this.connects.push(packet);
      if (this.connack === 'close') {
        socket.destroy();
        return;
      }
      if (this.connack === 'silent') return;
      const ok = packet.username === this.username && packet.password === this.password;
      const code = this.connack ?? (ok ? 0 : 5);
      socket.write(Buffer.from([0x20, 0x02, 0x00, code]));
      return;
    }
    if (packet.type === 8) {
      this.subscribed.add(socket);
      this.topic = packet.topic;
      const id = Buffer.alloc(2);
      id.writeUInt16BE(packet.packetId);
      socket.write(frame(0x90, Buffer.concat([id, Buffer.from([0])])));
      return;
    }
    if (packet.type === TYPE.PINGREQ) {
      socket.write(Buffer.from([0xd0, 0x00]));
      return;
    }
    if (packet.type === TYPE.PUBLISH) {
      let json;
      try {
        json = JSON.parse(packet.payload);
      } catch {
        return;
      }
      this.published.push({ topic: packet.topic, ...json });
      if (packet.topic === `/${this.serial}/server/publish/` && this.answer) this.respond(json);
    }
  }

  /** Sends a message to every subscribed client, on the gateway topic by default. */
  push(message, topic = `/${this.serial}/client/reciver/`) {
    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    for (const socket of this.subscribed) socket.write(publishFrame(topic, payload));
  }

  statusOf(device) {
    const property = [];
    const s = device.status ?? {};
    if (s.on !== undefined) property.push({ dpid: 20, value: s.on });
    if (s.brightness !== undefined) property.push({ dpid: 22, value: s.brightness });
    if (s.kelvin !== undefined) property.push({ dpid: 23, value: s.kelvin });
    if (s.hsv !== undefined) property.push({ dpid: 24, value: s.hsv });
    return property;
  }

  respond(json) {
    const gwSn = this.serial;
    // By bus, address and type: several DALI devices may share an address.
    const find = (d) =>
      this.installation.devices.find(
        (x) =>
          x.channel === d.channel &&
          x.address === d.address &&
          (d.devType ? x.devType === d.devType : x.devType.startsWith('01')),
      );
    switch (json.cmd) {
      case 'getVersion':
        this.push({ cmd: 'getVersionRes', gwSn, data: { swVersion: '1.2.3', fwVersion: '4.5.6' } });
        break;
      case 'searchDev':
        this.push({
          cmd: 'searchDevRes',
          gwSn,
          searchFlag: 'exited',
          searchStatus: 1,
          data: this.installation.devices.map(({ devType, channel, address, name }) => ({
            devType,
            channel,
            address,
            name,
          })),
        });
        break;
      case 'getGroup': {
        const byChannel = new Map();
        for (const g of this.installation.groups) {
          if (!byChannel.has(g.channel)) byChannel.set(g.channel, []);
          byChannel.get(g.channel).push({ groupId: g.groupId, name: g.name });
        }
        this.push({
          cmd: 'getGroupRes',
          gwSn,
          group: [...byChannel].map(([channel, data]) => ({ channel, data })),
        });
        break;
      }
      case 'readGroup': {
        const g = this.installation.groups.find(
          (x) => x.channel === json.channel && x.groupId === json.groupId,
        );
        if (!g) break;
        this.push({
          cmd: 'readGroupRes',
          gwSn,
          channel: g.channel,
          groupId: g.groupId,
          name: g.name,
          data: g.members.map((address) => {
            const d = find({ channel: g.channel, address });
            return { devType: d.devType, channel: d.channel, address: d.address };
          }),
        });
        break;
      }
      case 'getScene': {
        const byChannel = new Map();
        for (const s of this.installation.scenes) {
          if (!byChannel.has(s.channel)) byChannel.set(s.channel, []);
          byChannel.get(s.channel).push({ sceneId: s.sceneId, name: s.name });
        }
        this.push({
          cmd: 'getSceneRes',
          gwSn,
          scene: [...byChannel].map(([channel, data]) => ({ channel, data })),
        });
        break;
      }
      case 'readDev':
        for (const entry of json.data ?? []) {
          const d = find(entry);
          if (!d) continue;
          this.push({
            cmd: 'readDevRes',
            gwSn,
            data: {
              devType: d.devType,
              channel: d.channel,
              address: d.address,
              property: this.statusOf(d),
            },
          });
        }
        break;
      case 'writeDev':
        for (const entry of json.data ?? []) {
          const d = find(entry);
          if (!d) continue;
          d.status = d.status ?? {};
          for (const p of entry.property ?? []) {
            if (p.dpid === 20) d.status.on = p.value;
            if (p.dpid === 22) d.status.brightness = p.value;
            if (p.dpid === 23) d.status.kelvin = p.value;
            if (p.dpid === 24) d.status.hsv = p.value;
          }
        }
        break;
      default:
        break;
    }
  }
}
