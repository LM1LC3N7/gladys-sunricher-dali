// -----------------------------------------------------------------------------
// Pairing helper: finds the Sunricher DALI gateways of the local network and
// shows the MQTT user name and password a gateway gives after its button is
// pressed. Ported from PySrDaliGateway (udp_client.py, discovery.py;
// Apache-2.0, see THIRD_PARTY_NOTICES.md).
//
// Why a separate command: the gateway answers a UDP multicast request
// (239.255.255.250, port 1900; answers on port 50569), and the container of a
// Gladys integration sits behind a Docker bridge that multicast never
// crosses. So this runs once, on the host network:
//
//   docker run --rm -it --network host ghcr.io/lm1lc3n7/gladys-sunricher-dali:<version> node scripts/pair.mjs
//   (or `node scripts/pair.mjs` from a clone, with Node 22 or later)
//
// Options: --serial <serial number> (only that gateway), --timeout <seconds>
// (default 180, as PySrDaliGateway).
//
// The request and the answer are scrambled with AES-128-CTR under a fixed key
// published in PySrDaliGateway: a protocol convention of the gateway, not a
// secret of yours. The credentials are printed to this terminal only (never
// to a file or a log): copy them into the configuration of the integration.
// -----------------------------------------------------------------------------

import { createCipheriv, randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { pathToFileURL } from 'node:url';

export const PROTOCOL_KEY = 'SR-DALI-GW-HASYS';
const IV = Buffer.from('0000000000101111', 'utf8');
export const MULTICAST = '239.255.255.250';
export const SEND_PORT = 1900;
export const LISTEN_PORT = 50569;

/** AES-128-CTR of a text under a 16-character key -> hexadecimal (PySrDaliGateway MessageCryptor). */
export function scramble(text, key) {
  const cipher = createCipheriv('aes-128-ctr', Buffer.from(key, 'utf8'), IV);
  return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('hex');
}

/** The reverse (CTR is symmetric); undefined when it is not hexadecimal or not UTF-8 text. */
export function unscramble(hex, key) {
  if (typeof hex !== 'string' || hex.length > 512 || !/^(?:[0-9a-f]{2})*$/i.test(hex)) {
    return undefined;
  }
  const cipher = createCipheriv('aes-128-ctr', Buffer.from(key, 'utf8'), IV);
  const bytes = Buffer.concat([cipher.update(Buffer.from(hex, 'hex')), cipher.final()]);
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f�]/.test(text) ? undefined : text;
}

/** The discovery request (PySrDaliGateway prepare_discovery_message). */
export function discoveryRequest(serial) {
  const key = randomBytes(8).toString('hex');
  const cmd = scramble(`${key}${scramble('discover', key)}`, PROTOCOL_KEY);
  return Buffer.from(JSON.stringify({ cmd, type: 'HA', ...(serial ? { snList: [serial] } : {}) }));
}

const text = (value, max) =>
  // eslint-disable-next-line no-control-regex
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : '';

/** One answer -> { serial, name, ip, port, tls, username, password } or undefined. */
export function parseAnswer(buffer) {
  if (buffer.length > 4096) return undefined;
  let raw;
  try {
    raw = JSON.parse(buffer.toString('utf8'));
  } catch {
    return undefined;
  }
  const data = raw?.data;
  if (!data || typeof data !== 'object') return undefined;
  const serial = text(data.gwSn, 40);
  if (!/^[0-9A-Za-z]{4,40}$/.test(serial)) return undefined;
  const port =
    Number.isInteger(data.port) && data.port > 0 && data.port < 65536 ? data.port : undefined;
  const username = data.username ? unscramble(data.username, PROTOCOL_KEY) : '';
  const password = data.passwd ? unscramble(data.passwd, PROTOCOL_KEY) : '';
  return {
    serial,
    name: text(data.name, 64),
    ip: text(data.gwIp, 45),
    port,
    tls: Boolean(data.isMqttTls),
    username: username ?? '',
    password: password ?? '',
  };
}

function interfaces() {
  const found = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' && address.family !== 4) continue;
      if (address.internal || address.address.startsWith('169.254.')) continue;
      found.push(address.address);
    }
  }
  return found;
}

function parseArgs(argv) {
  const options = { serial: undefined, timeout: 180 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--serial') options.serial = text(argv[(i += 1)], 40);
    else if (argv[i] === '--timeout')
      options.timeout = Math.max(10, Math.min(600, Number(argv[(i += 1)]) || 180));
  }
  return options;
}

async function main() {
  const { serial, timeout } = parseArgs(process.argv.slice(2));
  const local = interfaces();
  if (local.length === 0) {
    console.error(
      'No network interface found. Run this on the host network (docker run --network host).',
    );
    process.exitCode = 1;
    return;
  }
  const listener = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.bind(LISTEN_PORT, () => {
      listener.off('error', reject);
      resolve();
    });
  });
  for (const address of local) {
    try {
      listener.addMembership(MULTICAST, address);
    } catch {
      // an interface without multicast
    }
  }
  const senders = local.map((address) => {
    const socket = dgram.createSocket('udp4');
    socket.bind(0, address, () => socket.setMulticastInterface(address));
    socket.on('error', () => undefined);
    return socket;
  });
  console.log(`Looking for Sunricher DALI gateways for ${timeout} s on ${local.join(', ')}.`);
  console.log('Press the button of the gateway once now (the Reset button, a short press).');
  const seen = new Set();
  let done = false;
  const finish = () => {
    done = true;
    clearInterval(ticker);
    clearTimeout(timer);
    listener.close();
    for (const socket of senders) socket.close();
  };
  listener.on('message', (buffer) => {
    if (done) return;
    const answer = parseAnswer(buffer);
    if (!answer || (serial && answer.serial !== serial)) return;
    if (!answer.username || !answer.password) {
      if (!seen.has(answer.serial)) {
        seen.add(answer.serial);
        console.log(
          `Gateway ${answer.serial} (${answer.ip}) seen: press its button to get its credentials.`,
        );
      }
      return;
    }
    console.log('');
    console.log(`Gateway found: ${answer.name || answer.serial}`);
    console.log(`  Address of the gateway:        ${answer.ip}`);
    console.log(`  MQTT port of the gateway:      ${answer.port ?? '?'}`);
    console.log(`  Serial number of the gateway:  ${answer.serial}`);
    console.log(`  User name:                     ${answer.username}`);
    console.log(`  Password:                      ${answer.password}`);
    console.log(`  TLS:                           ${answer.tls ? 'yes' : 'no'}`);
    console.log('');
    console.log('Copy these values into the configuration of the integration in Gladys,');
    console.log('then clear this terminal: the password is shown here only.');
    finish();
  });
  const send = () => {
    const request = discoveryRequest(serial);
    for (const socket of senders) socket.send(request, SEND_PORT, MULTICAST, () => undefined);
  };
  const ticker = setInterval(send, 2_000);
  const timer = setTimeout(() => {
    if (done) return;
    console.log(
      'No gateway answered with its credentials. Check that it is on the same network, then try again.',
    );
    process.exitCode = 1;
    finish();
  }, timeout * 1000);
  send();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`Pairing failed: ${err.message}`);
    process.exitCode = 1;
  });
}
