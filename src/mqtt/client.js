// -----------------------------------------------------------------------------
// One MQTT session with the DALI gateway, which is itself the MQTT broker
// (PySrDaliGateway gateway.py: the client connects to the gateway address and
// port with the user name and password the gateway gave at pairing).
//
// - One socket at a time; a generation number is bumped at every end, and
//   every listener and timer of an older socket checks it, so a late packet of
//   an old session is never taken.
// - TLS (when the gateway uses it): the certificate is checked against the
//   pinned fingerprint as soon as the handshake ends, BEFORE the CONNECT packet
//   that carries the password is written. A different certificate ends the
//   session with no new try.
// - A CONNACK 4 or 5 (bad user name or password, not authorized) is final, as
//   are two sessions in a row closed (or left unanswered) after CONNECT: never
//   a loop with a refused password.
// - Reconnections spaced 10 s, 30 s, 1 min, 2 min, then 5 min; a PINGREQ every
//   30 s, a missing PINGRESP cuts the session.
// - Only the PUBLISH packets of the subscribed topic, exactly, are passed on.
//
// Events: 'attempt', 'up' { fingerprint },
// 'message' { topic, payload }, 'down' { reason, retryIn, refused, silent,
// certificate, presented, wasUp }. The password is never logged.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createConnection, isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { LIMITS, TIMINGS } from '../constants.js';
import {
  PacketReader,
  REFUSED_CODES,
  TYPE,
  connect as connectPacket,
  disconnect as disconnectPacket,
  pingreq,
  puback,
  publish as publishPacket,
  subscribe as subscribePacket,
} from './packet.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** `AB:CD:...` (Node's fingerprint256) -> `abcd...`. */
export const fingerprintOf = (certificate) =>
  String(certificate?.fingerprint256 ?? '')
    .replace(/:/g, '')
    .toLowerCase();

export const colons = (hex) => (hex ? hex.match(/../g).join(':') : '?');

function defaultConnect({ host, port, tls }) {
  if (!tls) return createConnection({ host, port });
  // The certificate of the gateway is checked against the pin once the
  // handshake ends (session()), never against a public CA: the gateway has
  // no public name.
  return tlsConnect({
    host,
    port,
    rejectUnauthorized: false,
    ...(isIP(host) ? {} : { servername: host }),
  });
}

export class MqttSession extends EventEmitter {
  constructor({
    connect = defaultConnect,
    timers = globalThis,
    now = Date.now,
    logger = silent,
  } = {}) {
    super();
    this.connectFn = connect;
    this.timers = timers;
    this.now = now;
    this.logger = logger;
    this.options = {
      host: '',
      port: 1883,
      tls: false,
      username: '',
      password: '',
      fingerprint: '',
      topic: '',
      publishTopic: '',
    };
    this.socket = undefined;
    this.generation = 0;
    this.running = false;
    this.ready = false;
    this.failures = 0;
    this.silentDrops = 0;
    this.reconnectTimer = undefined;
    this.connectTimer = undefined;
    this.pingTimer = undefined;
    this.pongTimer = undefined;
    this.packetId = 0;
    /** (fingerprint) -> true once kept: set by the app (first contact over TLS). */
    this.learn = async () => true;
  }

  /** `topic`: the one subscribed to; `publishTopic`: where commands go. */
  configure({ host, port, tls, username, password, fingerprint, topic, publishTopic }) {
    this.options = {
      host,
      port,
      tls: Boolean(tls),
      username: username ?? '',
      password: password ?? '',
      fingerprint: fingerprint ?? '',
      topic,
      publishTopic,
    };
  }

  get connected() {
    return this.ready;
  }

  /** A socket is open (connecting or up). */
  get busy() {
    return Boolean(this.socket);
  }

  /** Starts the session, after `delay` ms (a restart never connects faster than the spacing). */
  start({ delay = 0 } = {}) {
    this.stop();
    this.running = true;
    this.failures = 0;
    this.silentDrops = 0;
    if (delay > 0) {
      this.reconnectTimer = this.timers.setTimeout(() => {
        this.reconnectTimer = undefined;
        if (this.running) this.open();
      }, delay);
      return;
    }
    this.open();
  }

  stop() {
    this.running = false;
    this.generation += 1;
    if (this.reconnectTimer) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.close({ polite: true });
  }

  clearTimers() {
    for (const name of ['connectTimer', 'pongTimer']) {
      if (this[name]) {
        this.timers.clearTimeout(this[name]);
        this[name] = undefined;
      }
    }
    if (this.pingTimer) {
      this.timers.clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  close({ polite = false } = {}) {
    this.clearTimers();
    const socket = this.socket;
    this.socket = undefined;
    this.ready = false;
    if (!socket) return;
    socket.removeAllListeners();
    socket.on('error', () => undefined);
    if (polite && this.connackSeen) {
      try {
        socket.end(disconnectPacket());
      } catch {
        // already gone
      }
      // Never left half open.
      const timer = this.timers.setTimeout(() => socket.destroy(), 1_000);
      timer?.unref?.();
      return;
    }
    socket.destroy();
  }

  // --- Connection -------------------------------------------------------------

  open() {
    this.generation += 1;
    const generation = this.generation;
    const { host, port, tls } = this.options;
    this.connectSent = false;
    this.connackSeen = false;
    this.presented = '';
    this.reader = new PacketReader({
      maxPacket: LIMITS.maxPacket,
      onPacket: (packet) => {
        if (generation === this.generation) this.packet(generation, packet);
      },
      onError: (err) => this.lost(generation, err.message),
    });
    this.emit('attempt');
    this.logger.debug(`Connecting to the DALI gateway at ${host}:${port} (${tls ? 'TLS' : 'TCP'})`);
    let socket;
    try {
      socket = this.connectFn({ host, port, tls });
    } catch (err) {
      this.lost(generation, `connection failed: ${err.message}`);
      return;
    }
    this.socket = socket;
    socket.setNoDelay?.(true);
    socket.setKeepAlive?.(true, 30_000);
    this.connectTimer = this.timers.setTimeout(
      () => this.lost(generation, 'connection timed out'),
      TIMINGS.connectTimeout,
    );
    socket.on(tls ? 'secureConnect' : 'connect', () => {
      if (generation === this.generation) this.session(generation, socket);
    });
    socket.on('data', (chunk) => {
      if (generation === this.generation) this.reader.push(chunk);
    });
    socket.on('error', (err) => this.lost(generation, err.code ?? err.message));
    socket.on('close', () => this.lost(generation, 'connection closed by the gateway'));
  }

  /** The socket is open (and the handshake done): check the certificate, then CONNECT. */
  session(generation, socket) {
    const { tls, fingerprint } = this.options;
    let seen = '';
    if (tls) {
      seen = fingerprintOf(socket.getPeerCertificate?.());
      this.presented = seen;
      if (!/^[0-9a-f]{64}$/.test(seen)) {
        this.lost(generation, 'no certificate from the gateway', { certificate: true });
        return;
      }
      if (fingerprint && seen !== fingerprint) {
        this.logger.error(
          `DALI gateway: its certificate (SHA-256 ${colons(seen)}) is not the pinned one (${colons(fingerprint)}): connection stopped, nothing sent`,
        );
        this.lost(generation, 'certificate not the pinned one', { certificate: true });
        return;
      }
      if (!fingerprint) {
        // First contact: the app keeps the fingerprint in /data, and only once
        // it is written does the password leave.
        Promise.resolve()
          .then(() => this.learn(seen))
          .then(
            (kept) => {
              if (generation !== this.generation) return;
              if (kept === false) {
                this.lost(generation, 'the certificate could not be kept', { certificate: true });
                return;
              }
              this.options.fingerprint = seen;
              this.sendConnect(generation);
            },
            (err) => this.lost(generation, `the certificate could not be kept: ${err.message}`),
          );
        return;
      }
    }
    this.sendConnect(generation);
  }

  sendConnect(generation) {
    const { username, password } = this.options;
    // A client id of our own, new at every session (a broker drops the older
    // session that holds the same id).
    const clientId = `gladys_dali_${randomBytes(6).toString('hex')}`;
    if (
      !this.write(
        generation,
        connectPacket({ clientId, username, password, keepAlive: TIMINGS.keepAlive }),
      )
    ) {
      return;
    }
    this.connectSent = true;
    this.logger.debug('DALI gateway <- CONNECT (password hidden)');
  }

  write(generation, bytes) {
    const socket = this.socket;
    if (!socket || generation !== this.generation) return false;
    try {
      socket.write(bytes);
    } catch (err) {
      this.lost(generation, err.message);
      return false;
    }
    if ((socket.writableLength ?? 0) > LIMITS.maxPendingWrite) {
      this.logger.warn('DALI gateway: too much data waiting to be written, session cut');
      this.lost(generation, 'write buffer full');
      return false;
    }
    return true;
  }

  packet(generation, packet) {
    if (packet.type === TYPE.CONNACK) {
      if (this.connackSeen || !this.connectSent) {
        this.lost(generation, 'unexpected CONNACK');
        return;
      }
      this.connackSeen = true;
      this.timers.clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
      if (packet.code !== 0) {
        const refused = REFUSED_CODES.has(packet.code);
        this.lost(generation, `the gateway refused the connection (code ${packet.code})`, {
          refused,
        });
        return;
      }
      this.silentDrops = 0;
      this.subscribeId = this.nextPacketId();
      this.write(generation, subscribePacket(this.subscribeId, this.options.topic));
      // The SUBACK must come in time too.
      this.connectTimer = this.timers.setTimeout(
        () => this.lost(generation, 'no answer to the subscription'),
        TIMINGS.connectTimeout,
      );
      return;
    }
    if (!this.connackSeen) {
      this.lost(generation, 'packet before CONNACK');
      return;
    }
    if (packet.type === TYPE.SUBACK) {
      if (packet.packetId !== this.subscribeId || this.ready) return;
      this.timers.clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
      if (packet.codes[0] === 0x80) {
        this.lost(generation, 'the gateway refused the subscription');
        return;
      }
      this.ready = true;
      this.failures = 0;
      this.pingTimer = this.timers.setInterval(() => this.ping(generation), TIMINGS.ping);
      this.emit('up', { fingerprint: this.presented });
      return;
    }
    if (packet.type === TYPE.PINGRESP) {
      if (this.pongTimer) this.timers.clearTimeout(this.pongTimer);
      this.pongTimer = undefined;
      return;
    }
    if (packet.type === TYPE.PUBLISH) {
      if (packet.qos === 1) this.write(generation, puback(packet.packetId));
      // QoS 2 was never asked (subscription in QoS 0): not taken.
      if (packet.qos === 2 || !this.ready) return;
      // The exact topic of this gateway only: a wildcard or another gateway is not ours.
      if (packet.topic !== this.options.topic) return;
      this.emit('message', { topic: packet.topic, payload: packet.payload });
    }
  }

  ping(generation) {
    if (generation !== this.generation || !this.ready || this.pongTimer) return;
    if (!this.write(generation, pingreq())) return;
    this.pongTimer = this.timers.setTimeout(() => {
      this.pongTimer = undefined;
      this.lost(generation, 'no answer to the keep alive');
    }, TIMINGS.pingTimeout);
  }

  nextPacketId() {
    this.packetId = (this.packetId % 0xffff) + 1;
    return this.packetId;
  }

  /** Publishes on the gateway; false when nothing could be written. */
  publish(payload) {
    if (!this.ready) return false;
    return this.write(this.generation, publishPacket(this.options.publishTopic, payload));
  }

  /** The session ended: reconnect later, unless stopped or refused. */
  lost(generation, reason, { certificate = false, refused = false } = {}) {
    if (generation !== this.generation) return;
    this.generation += 1;
    const wasUp = this.ready;
    // CONNECT written, then the socket closed or nothing came back: likely a
    // refused password on a broker that closes instead of answering.
    const silentDrop = this.connectSent && !this.connackSeen && !refused;
    const presented = this.presented;
    this.close();
    if (!this.running) return;
    let silent = false;
    if (silentDrop) {
      this.silentDrops += 1;
      if (this.silentDrops >= LIMITS.silentDrops) {
        silent = true;
        reason = 'connection closed after the user name and password, twice';
      }
    }
    let retryIn;
    if (refused || silent || certificate) {
      // Never again by itself: a refused password is not tried in a loop, a
      // password is never sent to a gateway that is not the pinned one.
      this.running = false;
    } else {
      this.failures = wasUp ? 1 : this.failures + 1;
      retryIn = TIMINGS.backoff[Math.min(this.failures - 1, TIMINGS.backoff.length - 1)];
      this.reconnectTimer = this.timers.setTimeout(() => {
        this.reconnectTimer = undefined;
        if (this.running) this.open();
      }, retryIn);
    }
    this.emit('down', {
      reason,
      retryIn,
      refused,
      silent,
      certificate,
      wasUp,
      presented,
      pinned: this.options.fingerprint,
    });
  }
}
