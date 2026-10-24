// -----------------------------------------------------------------------------
// The JSON messages of the Sunricher DALI gateway, ported from PySrDaliGateway
// (gateway.py, helper.py, device.py, group.py, scene.py; Apache-2.0, see
// THIRD_PARTY_NOTICES.md).
//
// Topics: the gateway publishes on `/<serial>/client/reciver/` (sic) and
// listens on `/<serial>/server/publish/`. Every message is a JSON object
// { cmd, msgId, gwSn, ... }.
//
// Changed from PySrDaliGateway: every message is validated strictly before
// use (a known command, the serial number of this gateway when the message
// carries one, integers in their DALI ranges, bounded lists and names, no
// value guessed): what does not fit is dropped, never half applied.
// -----------------------------------------------------------------------------

import { DPID, ILLUMINANCE_DPID, LIMITS, MOTION_DPIDS, PANEL_DPID_EVENTS } from '../constants.js';

export const subscribeTopic = (serial) => `/${serial}/client/reciver/`;
export const publishTopic = (serial) => `/${serial}/server/publish/`;

/** A strict integer: a number, or digits only (an empty text is not 0). */
export function integer(value, min, max) {
  let number;
  if (typeof value === 'number') number = value;
  else if (typeof value === 'string' && /^\d{1,9}$/.test(value)) number = Number(value);
  else return undefined;
  return Number.isInteger(number) && number >= min && number <= max ? number : undefined;
}

/** A finite number, or a decimal text. */
function decimal(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && /^-?\d{1,9}(\.\d{1,6})?$/.test(value)) return Number(value);
  return undefined;
}

/** On or off: a boolean, 0/1, or their texts. */
function flag(value) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return undefined;
}

/** A name from the gateway: text, no control character, bounded. */
export function cleanName(value) {
  if (typeof value !== 'string') return '';
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trim()
      .slice(0, LIMITS.maxName)
  );
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = (value, max) => (Array.isArray(value) ? value.slice(0, max) : []);

/** The DALI type of a device: 4 to 6 hexadecimal digits (`0101`, `020101`). */
export function devType(value) {
  return typeof value === 'string' && /^[0-9a-f]{4,6}$/i.test(value)
    ? value.toUpperCase()
    : undefined;
}

export const isLight = (type) => type.startsWith('01');
export const isMotion = (type) => type.startsWith('0201');
export const isIlluminance = (type) => type === '0202';
export const isPanel = (type) => type.startsWith('03');

/** What a light can do beyond on/off and brightness (PySrDaliGateway COLOR_MODE_MAP). */
export function colorMode(type) {
  if (type === '0102') return 'temperature';
  if (['0103', '0104', '0105', '0106'].includes(type)) return 'color';
  return 'brightness';
}

/** { devType, channel, address } of a message, all valid, or undefined. */
export function deviceRef(raw) {
  if (!isObject(raw)) return undefined;
  const type = devType(raw.devType);
  const channel = integer(raw.channel, 0, LIMITS.maxChannel);
  const address = integer(raw.address, 0, LIMITS.maxAddress);
  if (type === undefined || channel === undefined || address === undefined) return undefined;
  return { devType: type, channel, address };
}

export const deviceKey = ({ channel, address }) => `${channel}-${address}`;

// --- Outgoing ------------------------------------------------------------------

/** The message envelope (PySrDaliGateway _publish_command). */
export function message(serial, cmd, fields = {}, now = Date.now()) {
  return JSON.stringify({ cmd, msgId: String(Math.floor(now / 1000)), gwSn: serial, ...fields });
}

const property = (dpid, dataType, value) => ({ dpid, dataType, value });

export const powerProperty = (on) => property(DPID.POWER, 'bool', Boolean(on));

/** Gladys brightness 0-100 -> the gateway's 0-1000. */
export const brightnessProperty = (percent) =>
  property(DPID.BRIGHTNESS, 'uint16', Math.round(Math.max(0, Math.min(100, percent)) * 10));

/** Gladys colour temperature (mired) -> kelvin. */
export const temperatureProperty = (mired) =>
  property(DPID.COLOR_TEMP, 'uint16', Math.round(1_000_000 / mired));

const hex4 = (value) => Math.round(value).toString(16).padStart(4, '0');

/** Gladys colour (0xRRGGBB) -> HSV text, value at full (the brightness is its own feature). */
export function colorProperty(rgb) {
  const r = ((rgb >> 16) & 0xff) / 255;
  const g = ((rgb >> 8) & 0xff) / 255;
  const b = (rgb & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : delta / max;
  return property(DPID.HSV, 'string', `${hex4(h)}${hex4(s * 1000)}${hex4(1000)}`);
}

// --- Incoming ------------------------------------------------------------------

/** HSV text of the gateway -> Gladys colour (0xRRGGBB, at full value), or undefined. */
export function hsvToColor(text) {
  if (typeof text !== 'string' || !/^[0-9a-f]{8}(?:[0-9a-f]{4})?$/i.test(text)) return undefined;
  const h = Math.min(360, Number.parseInt(text.slice(0, 4), 16));
  const s = Math.min(1000, Number.parseInt(text.slice(4, 8), 16)) / 1000;
  const c = s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = 1 - c;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  const byte = (v) => Math.round((v + m) * 255);
  return (byte(r) << 16) | (byte(g) << 8) | byte(b);
}

/** Kelvin -> Gladys mired, bounded to the feature range. */
export const kelvinToMired = (kelvin) => Math.round(1_000_000 / kelvin);

/** The properties of a status -> Map(dpid -> raw value), bounded. */
function properties(raw) {
  const map = new Map();
  for (const prop of list(raw, LIMITS.maxProperties)) {
    if (!isObject(prop)) continue;
    const dpid = integer(prop.dpid ?? prop.id, 0, 255);
    if (dpid === undefined || prop.value === undefined || prop.value === null) continue;
    map.set(dpid, prop.value);
  }
  return map;
}

/** A light status (PySrDaliGateway parse_light_status): only the values present and valid. */
export function parseLight(rawProperties) {
  const props = properties(rawProperties);
  const status = {};
  if (props.has(DPID.POWER)) {
    const on = flag(props.get(DPID.POWER));
    if (on !== undefined) status.on = on;
  }
  if (props.has(DPID.BRIGHTNESS)) {
    const level = decimal(props.get(DPID.BRIGHTNESS));
    if (level !== undefined && level >= 0 && level <= 1000) status.brightness = level;
  }
  if (props.has(DPID.COLOR_TEMP)) {
    const kelvin = integer(props.get(DPID.COLOR_TEMP), 1000, 20000);
    if (kelvin !== undefined) status.kelvin = kelvin;
  }
  if (props.has(DPID.HSV)) {
    const color = hsvToColor(props.get(DPID.HSV));
    if (color !== undefined) status.color = color;
  }
  return status;
}

/** Motion sensor events (PySrDaliGateway parse_motion_status): only the known data points. */
export function parseMotion(rawProperties) {
  const events = [];
  for (const prop of list(rawProperties, LIMITS.maxProperties)) {
    const dpid = isObject(prop) ? integer(prop.dpid, 0, 255) : undefined;
    // An unknown data point is not "no motion" (PySrDaliGateway assumes it): dropped.
    if (dpid !== undefined && MOTION_DPIDS.has(dpid)) events.push(MOTION_DPIDS.get(dpid));
  }
  return events;
}

/** Illuminance (lux), valid above 0 and up to 1000 (PySrDaliGateway parse_illuminance_status). */
export function parseIlluminance(rawProperties) {
  let lux;
  for (const prop of list(rawProperties, LIMITS.maxProperties)) {
    if (!isObject(prop) || integer(prop.dpid, 0, 255) !== ILLUMINANCE_DPID) continue;
    const value = decimal(prop.value);
    if (value !== undefined && value > 0 && value <= 1000) lux = value;
  }
  return lux;
}

/** Panel key events (PySrDaliGateway parse_panel_status). */
export function parsePanel(rawProperties) {
  const events = [];
  for (const prop of list(rawProperties, LIMITS.maxProperties)) {
    if (!isObject(prop)) continue;
    const event = PANEL_DPID_EVENTS.get(integer(prop.dpid, 0, 255));
    const key = integer(prop.keyNo, 0, 16);
    if (!event || key === undefined) continue;
    const rotate = event === 'rotate' ? decimal(prop.value) : undefined;
    events.push({ key, event, rotate: rotate ?? null });
  }
  return events;
}

/** A device of a search answer -> { devType, channel, address, name, devSn, area } or undefined. */
function searchedDevice(raw) {
  const ref = deviceRef(raw);
  if (!ref) return undefined;
  return {
    ...ref,
    name: cleanName(raw.name),
    devSn: cleanName(raw.devSn).slice(0, 40),
    area: cleanName(raw.areaName),
  };
}

/**
 * One message from the gateway -> a normalized event, or { ignored: reason }.
 * Events: version, search, groups, group, scenes, status, online.
 */
export function parseMessage(payload, serial) {
  let raw;
  try {
    raw = JSON.parse(Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload));
  } catch {
    return { ignored: 'not JSON' };
  }
  if (!isObject(raw)) return { ignored: 'not an object' };
  if (typeof raw.cmd !== 'string' || raw.cmd.length > 40) return { ignored: 'no command' };
  // A message of another gateway is never applied to this one.
  if (raw.gwSn !== undefined && raw.gwSn !== serial) return { ignored: 'another serial number' };
  const cmd = raw.cmd;
  switch (cmd) {
    case 'getVersionRes': {
      const data = isObject(raw.data) ? raw.data : {};
      return {
        kind: 'version',
        software: cleanName(data.swVersion),
        firmware: cleanName(data.fwVersion),
      };
    }
    case 'searchDevRes': {
      const status = integer(raw.searchStatus, 0, 9);
      const devices = list(raw.data, LIMITS.maxDevices).map(searchedDevice).filter(Boolean);
      // Only the answer from the gateway's list ("exited"), never a bus scan.
      if (raw.searchFlag !== undefined && raw.searchFlag !== 'exited') {
        return { ignored: 'bus scan answer' };
      }
      return { kind: 'search', devices, done: status === 0 || status === 1 };
    }
    case 'getGroupRes':
    case 'getSceneRes': {
      const isGroup = cmd === 'getGroupRes';
      const entries = [];
      for (const perChannel of list(isGroup ? raw.group : raw.scene, LIMITS.maxChannel + 1)) {
        if (!isObject(perChannel)) continue;
        const channel = integer(perChannel.channel, 0, LIMITS.maxChannel);
        if (channel === undefined) continue;
        for (const item of list(perChannel.data, 64)) {
          if (!isObject(item)) continue;
          const id = integer(
            isGroup ? item.groupId : item.sceneId,
            0,
            isGroup ? LIMITS.maxGroupId : LIMITS.maxSceneId,
          );
          if (id === undefined) continue;
          entries.push({ channel, id, name: cleanName(item.name) });
        }
      }
      return isGroup ? { kind: 'groups', groups: entries } : { kind: 'scenes', scenes: entries };
    }
    case 'readGroupRes': {
      const channel = integer(raw.channel, 0, LIMITS.maxChannel);
      const id = integer(raw.groupId, 0, LIMITS.maxGroupId);
      if (channel === undefined || id === undefined) return { ignored: 'bad group' };
      const members = list(raw.data, LIMITS.maxMembers).map(deviceRef).filter(Boolean);
      return { kind: 'group', channel, id, name: cleanName(raw.name), members };
    }
    case 'devStatus':
    case 'readDevRes': {
      const ref = deviceRef(raw.data);
      if (!ref) return { ignored: 'bad device' };
      return { kind: 'status', ref, properties: raw.data.property };
    }
    case 'onlineStatus': {
      const entries = [];
      for (const item of list(raw.data, LIMITS.maxDevices)) {
        const ref = deviceRef(item);
        const online = isObject(item) ? flag(item.status) : undefined;
        if (ref && online !== undefined) entries.push({ ref, online });
      }
      return { kind: 'online', entries };
    }
    default:
      return { ignored: `command ${cmd.replace(/[^A-Za-z]/g, '').slice(0, 40)}` };
  }
}
