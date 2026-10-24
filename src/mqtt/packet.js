// -----------------------------------------------------------------------------
// The few MQTT 3.1.1 packets one client needs (OASIS MQTT 3.1.1, chapters 2
// and 3): CONNECT, CONNACK, SUBSCRIBE, SUBACK, PUBLISH (QoS 0 out, 0 or 1
// in), PUBACK, PINGREQ, PINGRESP, DISCONNECT. Written here rather than taken
// from an MQTT library so that the session stays in our hands: one socket,
// the certificate checked before the first byte (the password goes in
// CONNECT), every packet bounded in size.
// -----------------------------------------------------------------------------

export const TYPE = {
  CONNECT: 1,
  CONNACK: 2,
  PUBLISH: 3,
  PUBACK: 4,
  SUBSCRIBE: 8,
  SUBACK: 9,
  PINGREQ: 12,
  PINGRESP: 13,
  DISCONNECT: 14,
};

/** CONNACK return codes 4 (bad user name or password) and 5 (not authorized): a refusal. */
export const REFUSED_CODES = new Set([4, 5]);

function remainingLength(length) {
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

function packet(type, flags, body) {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), remainingLength(body.length), body]);
}

function string(text) {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > 0xffff) throw new Error('MQTT string too long');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

export function connect({ clientId, username, password, keepAlive }) {
  let flags = 0x02; // clean session: nothing kept by the broker between sessions
  if (username) flags |= 0x80;
  if (username && password) flags |= 0x40;
  const header = Buffer.alloc(4);
  header[0] = 4; // protocol level 3.1.1
  header[1] = flags;
  header.writeUInt16BE(keepAlive, 2);
  return packet(
    TYPE.CONNECT,
    0,
    Buffer.concat([
      string('MQTT'),
      header,
      string(clientId),
      ...(username ? [string(username)] : []),
      ...(username && password ? [string(password)] : []),
    ]),
  );
}

export function subscribe(packetId, topic) {
  const id = Buffer.alloc(2);
  id.writeUInt16BE(packetId);
  // QoS 0 asked: the gateway sends status pushes, a lost one is read again.
  return packet(TYPE.SUBSCRIBE, 0x02, Buffer.concat([id, string(topic), Buffer.from([0])]));
}

export function publish(topic, payload) {
  return packet(TYPE.PUBLISH, 0, Buffer.concat([string(topic), Buffer.from(payload, 'utf8')]));
}

export function puback(packetId) {
  const id = Buffer.alloc(2);
  id.writeUInt16BE(packetId);
  return packet(TYPE.PUBACK, 0, id);
}

export const pingreq = () => Buffer.from([0xc0, 0x00]);
export const disconnect = () => Buffer.from([0xe0, 0x00]);

/** Decodes the body of one packet -> { type, ... } or throws on a malformed one. */
export function decode(type, flags, body) {
  switch (type) {
    case TYPE.CONNACK:
      if (body.length !== 2) throw new Error('malformed CONNACK');
      return { type, sessionPresent: Boolean(body[0] & 1), code: body[1] };
    case TYPE.SUBACK:
      if (body.length < 3) throw new Error('malformed SUBACK');
      return { type, packetId: body.readUInt16BE(0), codes: [...body.subarray(2)] };
    case TYPE.PUBLISH: {
      const qos = (flags >> 1) & 3;
      if (qos === 3 || body.length < 2) throw new Error('malformed PUBLISH');
      const topicLength = body.readUInt16BE(0);
      let offset = 2 + topicLength;
      if (offset > body.length) throw new Error('malformed PUBLISH');
      const topic = body.subarray(2, offset).toString('utf8');
      let packetId;
      if (qos > 0) {
        if (offset + 2 > body.length) throw new Error('malformed PUBLISH');
        packetId = body.readUInt16BE(offset);
        offset += 2;
      }
      return { type, qos, topic, packetId, payload: body.subarray(offset) };
    }
    case TYPE.PINGRESP:
    case TYPE.PUBACK:
      return { type };
    default:
      // A server never sends CONNECT, SUBSCRIBE, PINGREQ... to a client.
      throw new Error(`unexpected MQTT packet type ${type}`);
  }
}

/**
 * Cuts the byte stream into packets, bounded: a packet over `maxPacket` (or a
 * malformed length) is an error, and the session ends. The chunks of a large
 * packet are kept in a list and joined once (no quadratic concatenation).
 */
export class PacketReader {
  constructor({ maxPacket, onPacket, onError }) {
    this.maxPacket = maxPacket;
    this.onPacket = onPacket;
    this.onError = onError;
    this.chunks = [];
    this.length = 0;
    this.failed = false;
  }

  push(chunk) {
    if (this.failed) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
    try {
      this.drain();
    } catch (err) {
      this.failed = true;
      this.chunks = [];
      this.length = 0;
      this.onError(err);
    }
  }

  /** The first `n` bytes (n <= length), joining only what is needed. */
  head(n) {
    if (this.chunks[0].length >= n) return this.chunks[0];
    const joined = Buffer.concat(this.chunks, this.length);
    this.chunks = [joined];
    return joined;
  }

  take(n) {
    const joined = this.head(n);
    const out = joined.subarray(0, n);
    const rest = joined.subarray(n);
    this.chunks = rest.length > 0 ? [rest] : [];
    this.length -= n;
    return out;
  }

  drain() {
    while (this.length >= 2) {
      const head = this.head(Math.min(this.length, 5));
      let size = 0;
      let multiplier = 1;
      let index = 1;
      let complete = false;
      while (index < head.length && index <= 4) {
        const byte = head[index];
        size += (byte & 0x7f) * multiplier;
        multiplier *= 128;
        index += 1;
        if ((byte & 0x80) === 0) {
          complete = true;
          break;
        }
      }
      if (!complete) {
        if (index > 4) throw new Error('malformed MQTT length');
        return; // the length is not all here yet
      }
      if (size > this.maxPacket) throw new Error(`MQTT packet too large (${size} bytes)`);
      // Joined once, when the whole packet is here.
      if (this.length < index + size) return;
      const bytes = this.take(index + size);
      const type = bytes[0] >> 4;
      const flags = bytes[0] & 0x0f;
      this.onPacket(decode(type, flags, Buffer.from(bytes.subarray(index))));
    }
  }
}
