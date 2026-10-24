// -----------------------------------------------------------------------------
// The gateway model -> Gladys devices and states (pure).
//
// External ids (frozen, documented in TODO.md "Decisions"): the serial number
// of the gateway (lower case), then the DALI bus (channel) and the short
// address, group or scene number, which is how a DALI installation is wired:
// - `light:<serial>-<bus>-<address>`: on/off, brightness, and, by DALI type,
//   the colour temperature (DT8 Tc) or the colour (DT8 RGB, XY, RGBW, RGBWA);
// - `motion:<serial>-<bus>-<address>`: motion, occupancy (read only);
// - `illuminance:<serial>-<bus>-<address>`: lux (read only);
// - `group:<serial>-<bus>-<group>`: on/off, brightness of a DALI group;
// - `scene:<serial>-<bus>-<scene>`: a push button that recalls the scene.
// Push button panels are no device: their keys are scene triggers.
//
// A device published again never loses a feature the user created (Gladys
// would mark it changed, and "Update" would drop its history): the features
// of the created device that the gateway no longer gives are kept.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { colorMode, isIlluminance, isLight, isMotion } from './dali/protocol.js';
import { DEVICE_NAMES, FEATURE_NAMES, word } from './i18n.js';

/** Colour temperature range offered in Gladys, in mired (6500 K to 2000 K). */
export const MIRED = { min: 153, max: 500 };

const command = (category, type, extra = {}) => ({
  category,
  type,
  read_only: false,
  has_feedback: true,
  keep_history: true,
  ...extra,
});

const reading = (category, type, extra = {}) => ({
  category,
  type,
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...extra,
});

/** Feature definitions by key (the last part of their external id). Keys are forever. */
export const LIGHT_FEATURES = {
  binary: command(C.LIGHT, T.LIGHT.BINARY, { min: 0, max: 1 }),
  brightness: command(C.LIGHT, T.LIGHT.BRIGHTNESS, { min: 0, max: 100 }),
  temperature: command(C.LIGHT, T.LIGHT.TEMPERATURE, { min: MIRED.min, max: MIRED.max }),
  color: command(C.LIGHT, T.LIGHT.COLOR, { min: 0, max: 0xffffff, keep_history: false }),
};

/** A group has no status of its own: what Gladys shows is derived from its members. */
export const GROUP_FEATURES = {
  binary: command(C.LIGHT, T.LIGHT.BINARY, { min: 0, max: 1, has_feedback: false }),
  brightness: command(C.LIGHT, T.LIGHT.BRIGHTNESS, { min: 0, max: 100, has_feedback: false }),
};

export const MOTION_FEATURES = {
  motion: reading(C.MOTION_SENSOR, T.SENSOR.BINARY, { min: 0, max: 1 }),
  occupancy: reading(C.PRESENCE_SENSOR, T.SENSOR.BINARY, { min: 0, max: 1 }),
};

export const ILLUMINANCE_FEATURES = {
  illuminance: reading(C.LIGHT_SENSOR, T.SENSOR.DECIMAL, { unit: U.LUX, min: 0, max: 1000 }),
};

export const SCENE_FEATURES = {
  activate: {
    category: C.BUTTON,
    type: T.BUTTON.PUSH,
    min: 0,
    max: 1,
    read_only: false,
    has_feedback: false,
    keep_history: false,
  },
};

/** The Gladys kind of a DALI device, undefined when it is not shown as a device. */
export function deviceKind(type) {
  if (isLight(type)) return 'light';
  if (isMotion(type)) return 'motion';
  if (isIlluminance(type)) return 'illuminance';
  return undefined;
}

export function lightFeatureKeys(type) {
  const mode = colorMode(type);
  if (mode === 'temperature') return ['binary', 'brightness', 'temperature'];
  if (mode === 'color') return ['binary', 'brightness', 'color'];
  return ['binary', 'brightness'];
}

const featureSet = (kind, type) => {
  if (kind === 'light') {
    return Object.fromEntries(lightFeatureKeys(type).map((key) => [key, LIGHT_FEATURES[key]]));
  }
  if (kind === 'motion') return MOTION_FEATURES;
  if (kind === 'illuminance') return ILLUMINANCE_FEATURES;
  if (kind === 'group') return GROUP_FEATURES;
  return SCENE_FEATURES;
};

export const platformId = (serial, channel, number) =>
  `${serial.toLowerCase()}-${channel}-${number}`;

export const idsOf = (gladys, kind, serial, channel, number) =>
  gladys.externalIds(kind, platformId(serial, channel, number));

/** `ext:sel:light:abc-0-12:brightness` -> { kind, serial, channel, number, key }. */
export function parseFeatureId(externalId) {
  const match =
    /:(light|motion|illuminance|group|scene):([0-9a-z]{4,40})-(\d{1,2})-(\d{1,2}):([a-z]+)$/.exec(
      String(externalId ?? ''),
    );
  if (!match) return undefined;
  return {
    kind: match[1],
    serial: match[2],
    channel: Number(match[3]),
    number: Number(match[4]),
    key: match[5],
  };
}

/** What a discovered feature declares (a created one also has ids, values, dates). */
const FEATURE_FIELDS = [
  'name',
  'external_id',
  'category',
  'type',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'unit',
  'supported_options',
];

/** Adds to each device the features of its created twin it no longer has. */
export function keepCreatedFeatures(devices, created = []) {
  const byId = new Map((created ?? []).map((device) => [device.external_id, device]));
  return devices.map((device) => {
    const twin = byId.get(device.external_id);
    if (!twin?.features?.length) return device;
    const have = new Set(device.features.map((f) => f.external_id));
    const kept = twin.features
      .filter((f) => f?.external_id && !have.has(f.external_id))
      .map((f) =>
        Object.fromEntries(
          FEATURE_FIELDS.filter((key) => f[key] !== undefined && f[key] !== null).map((key) => [
            key,
            f[key],
          ]),
        ),
      );
    return kept.length === 0 ? device : { ...device, features: [...device.features, ...kept] };
  });
}

const byBusAndNumber = (a, b) => a.channel - b.channel || a.number - b.number;

/** Every device shown, in a stable order: { kind, channel, number, entry }. */
export function shownEntries(model) {
  const entries = [];
  for (const device of model.devices.values()) {
    const kind = deviceKind(device.devType);
    if (kind)
      entries.push({ kind, channel: device.channel, number: device.address, entry: device });
  }
  for (const group of model.groups.values()) {
    entries.push({ kind: 'group', channel: group.channel, number: group.id, entry: group });
  }
  for (const scene of model.scenes.values()) {
    entries.push({ kind: 'scene', channel: scene.channel, number: scene.id, entry: scene });
  }
  const order = ['light', 'group', 'scene', 'motion', 'illuminance'];
  return entries.sort(
    (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || byBusAndNumber(a, b),
  );
}

export function buildDevices(gladys, config, model, created = gladys.devices) {
  const { language } = config;
  const devices = [];
  for (const { kind, channel, number, entry } of shownEntries(model)) {
    const ids = idsOf(gladys, kind, model.serial, channel, number);
    const name = entry.name || word(DEVICE_NAMES[kind], language)(channel, number);
    const features = Object.entries(featureSet(kind, entry.devType)).map(([key, definition]) => ({
      name: word(FEATURE_NAMES[key], language),
      external_id: ids.feature(key),
      ...definition,
    }));
    const params = [
      { name: 'bus', value: String(channel) },
      {
        name: kind === 'group' ? 'group' : kind === 'scene' ? 'scene' : 'address',
        value: String(number),
      },
    ];
    if (entry.devType) params.push({ name: 'dali_type', value: entry.devType });
    if (entry.area) params.push({ name: 'area', value: entry.area });
    devices.push({
      name,
      external_id: ids.device,
      model: kind === 'group' ? 'DALI group' : kind === 'scene' ? 'DALI scene' : entry.devType,
      should_poll: false,
      params,
      features,
    });
  }
  return keepCreatedFeatures(devices, created);
}

const flag = (value) => (value ? 1 : 0);

/** Every known state: `[{ device_feature_external_id, state }]`. */
export function buildStates(gladys, model) {
  const states = [];
  const push = (ids, key, value) => {
    if (value === undefined || value === null || Number.isNaN(value)) return;
    states.push({ device_feature_external_id: ids.feature(key), state: value });
  };
  for (const { kind, channel, number, entry } of shownEntries(model)) {
    const ids = idsOf(gladys, kind, model.serial, channel, number);
    if (kind === 'light') {
      const status = entry.status ?? {};
      const keys = new Set(lightFeatureKeys(entry.devType));
      if (status.on !== undefined) push(ids, 'binary', flag(status.on));
      if (status.brightness !== undefined)
        push(ids, 'brightness', Math.round(status.brightness / 10));
      if (keys.has('temperature') && status.kelvin !== undefined) {
        const mired = Math.round(1_000_000 / status.kelvin);
        push(ids, 'temperature', Math.max(MIRED.min, Math.min(MIRED.max, mired)));
      }
      if (keys.has('color') && status.color !== undefined) push(ids, 'color', status.color);
    } else if (kind === 'motion') {
      if (entry.motion !== undefined) push(ids, 'motion', flag(entry.motion));
      if (entry.occupancy !== undefined) push(ids, 'occupancy', flag(entry.occupancy));
    } else if (kind === 'illuminance') {
      if (entry.lux !== undefined) push(ids, 'illuminance', Math.round(entry.lux * 10) / 10);
    } else if (kind === 'group' && entry.members?.length > 0) {
      // On when a member is on, off when all are off; unknown while a member is unknown.
      const ons = entry.members.map((key) => model.devices.get(key)?.status?.on);
      if (ons.every((on) => on !== undefined)) push(ids, 'binary', flag(ons.some(Boolean)));
    }
  }
  return states;
}
