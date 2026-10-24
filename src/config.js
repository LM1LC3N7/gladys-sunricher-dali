// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized.
// -----------------------------------------------------------------------------

import { DEFAULT_PORT } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  port: DEFAULT_PORT,
  tls: false,
  language: 'fr',
};

export const LANGUAGES = ['fr', 'en'];

const integer = (value, fallback, min, max) => {
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) {
    return value;
  }
  if (typeof value === 'string' && /^\d{1,5}$/.test(value.trim())) {
    const number = Number(value.trim());
    if (number >= min && number <= max) return number;
  }
  return fallback;
};

/** `192.168.1.9`, `dali.lan` -> the host; anything else (a URL, a path, a port, spaces) -> ''. */
export function parseHost(raw) {
  const text = String(raw ?? '').trim();
  if (/^[0-9a-z.-]{1,253}$/i.test(text) && !text.startsWith('-')) return text;
  // IPv6 in brackets or bare.
  const v6 = /^\[?([0-9a-f:]{2,39})\]?$/i.exec(text);
  return v6 && v6[1].includes(':') ? v6[1] : '';
}

/**
 * The serial number of the gateway, as the pairing shows it (`gwSn`, the MAC
 * address in upper case without separators on the SR-GW-EDA). A MAC written
 * with colons or dashes is joined; otherwise letters and digits only, since
 * the serial number is part of the MQTT topics (no `/`, `+`, `#`).
 */
export function normalizeSerial(raw) {
  const text = String(raw ?? '').trim();
  if (/^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i.test(text))
    return text.replace(/[:-]/g, '').toUpperCase();
  // The SR-GW-EDA form (12 hexadecimal digits) in capitals, however typed.
  if (/^[0-9a-f]{12}$/i.test(text)) return text.toUpperCase();
  return /^[0-9A-Za-z]{4,40}$/.test(text) ? text : '';
}

/** A SHA-256 certificate fingerprint, any common writing -> 64 lower-case hex digits, '' if absent. */
export function normalizeFingerprint(raw) {
  const text = String(raw ?? '')
    .replace(/^sha-?256\s*[:=]?\s*/i, '')
    .replace(/[\s:-]/g, '')
    .toLowerCase();
  return /^[0-9a-f]{64}$/.test(text) ? text : '';
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export function normalizeConfig(raw = {}) {
  const language = String(raw?.language ?? DEFAULTS.language)
    .trim()
    .toLowerCase();
  const typedFingerprint = String(raw?.tls_fingerprint ?? '').trim();
  const username = typeof raw?.username === 'string' ? raw.username.trim() : '';
  // As typed: a password may hold spaces. A control character is refused (it
  // would be a paste error).
  const password = typeof raw?.password === 'string' ? raw.password : '';
  return {
    host: parseHost(raw?.host),
    hostTyped: String(raw?.host ?? '').trim() !== '',
    port: integer(raw?.port, DEFAULTS.port, 1, 65535),
    serial: normalizeSerial(raw?.serial_number),
    serialTyped: String(raw?.serial_number ?? '').trim() !== '',
    username: CONTROL.test(username) || username.length > 200 ? '' : username,
    usernameInvalid: CONTROL.test(username) || username.length > 200,
    password: CONTROL.test(password) || password.length > 200 ? '' : password,
    passwordInvalid: CONTROL.test(password) || password.length > 200,
    tls: typeof raw?.tls === 'boolean' ? raw.tls : DEFAULTS.tls,
    fingerprint: normalizeFingerprint(typedFingerprint),
    fingerprintInvalid: typedFingerprint !== '' && normalizeFingerprint(typedFingerprint) === '',
    language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
  };
}

/** What the session depends on: a change reconnects (and lifts a stop on a refused password). */
export const sessionKey = (config) =>
  JSON.stringify([
    config.host,
    config.port,
    config.serial,
    config.username,
    config.password,
    config.tls,
    config.fingerprint,
  ]);

/** Where the session goes, without the credentials: what a persisted stop or pin is tied to. */
export const placeKey = (config) =>
  `${config.tls ? 'tls' : 'tcp'}://${config.host}:${config.port}/${config.serial}`;
