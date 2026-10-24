// -----------------------------------------------------------------------------
// Fixed values: manifest keys, DALI data points, limits and timings.
// -----------------------------------------------------------------------------

/** Manifest keys: frozen, users store them in scenes and dashboards. */
export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

export const SCENE_TRIGGERS = {
  PANEL_BUTTON: 'panel_button',
};

/** What a key of a DALI-2 push button panel did (frozen: scenes compare them). */
export const BUTTON_EVENTS = ['press', 'hold', 'double_press', 'rotate', 'release'];

/**
 * Data points of the gateway protocol (PySrDaliGateway const.py): power,
 * white level (0-255), brightness (0-1000), colour temperature (kelvin),
 * colour (HSV as hexadecimal text).
 */
export const DPID = {
  POWER: 20,
  WHITE: 21,
  BRIGHTNESS: 22,
  COLOR_TEMP: 23,
  HSV: 24,
};

/** Panel data points: the event of a key (PySrDaliGateway BUTTON_EVENTS). */
export const PANEL_DPID_EVENTS = new Map([
  [1, 'press'],
  [2, 'hold'],
  [3, 'double_press'],
  [4, 'rotate'],
  [5, 'release'],
]);

/** Motion sensor data points (PySrDaliGateway helper.py _MOTION_STATE_MAP). */
export const MOTION_DPIDS = new Map([
  [1, 'no_motion'],
  [2, 'motion'],
  [3, 'vacant'],
  [4, 'occupancy'],
  [5, 'presence'],
]);

/** Illuminance sensor: its value data point. */
export const ILLUMINANCE_DPID = 4;

/** The gateway is the MQTT broker: 1883 unless the pairing told another port. */
export const DEFAULT_PORT = 1883;

export const LIMITS = {
  /** DALI short addresses 0 to 63, groups and scenes 0 to 15, at most 16 channels (buses). */
  maxAddress: 63,
  maxGroupId: 15,
  maxSceneId: 15,
  maxChannel: 15,
  /** Devices kept from one gateway (64 addresses on 16 buses). */
  maxDevices: 1024,
  maxGroups: 256,
  maxScenes: 256,
  /** Members of one group, properties of one status. */
  maxMembers: 64,
  maxProperties: 32,
  /** Characters of a name kept from the gateway. */
  maxName: 64,
  /** An MQTT packet larger than this ends the session (a device list is far smaller). */
  maxPacket: 512 * 1024,
  /** Bytes waiting in the socket write buffer before the session is cut. */
  maxPendingWrite: 256 * 1024,
  /** Messages accepted from the gateway per 10 s; more are dropped (counted). */
  maxMessagesPer10s: 1000,
  /** Entries of one batched command (writeDev, readDev) per MQTT message. */
  batchSize: 32,
  /** States per minute sent to Gladys (the core admits 300). */
  statesPerMinute: 240,
  /** Part of it only the lights and motion sensors may use. */
  priorityStates: 60,
  /** Scene events per minute (the core admits 300): button presses over it are dropped. */
  eventsPerMinute: 120,
  /** Sessions closed by the gateway right after CONNECT without an answer, in a row: a refusal. */
  silentDrops: 2,
  /** Group reads at the same time (PySrDaliGateway MAX_CONCURRENT_READS). */
  concurrentReads: 3,
};

export const TIMINGS = {
  /** TCP (and TLS) connection to the gateway, then its CONNACK. */
  connectTimeout: 15_000,
  /** Waits before reconnecting, in a row (the last one repeats), never under 10 s. */
  backoff: [10_000, 30_000, 60_000, 120_000, 300_000],
  /** MQTT keep alive announced to the gateway (seconds) and the ping that keeps it. */
  keepAlive: 60,
  ping: 30_000,
  /** A PINGRESP must come this soon, else the session is cut. */
  pingTimeout: 15_000,
  /** Commands of the same kind written within this window share one message (PySrDaliGateway: 100 ms). */
  batchWindow: 100,
  /** The answer to a device, group or scene list. */
  listTimeout: 30_000,
  /** The answer to the read of one group. */
  readTimeout: 10_000,
  /** "Scan" in Gladys asks the gateway again at most this often. */
  scanInterval: 60_000,
  /** A command is written by then after it was asked, or refused (nothing sent). */
  sendBy: 3_500,
  /** The device is read back this long after a command. */
  readBack: 1_500,
  /** How often the unchanged states get their heartbeat checked. */
  sweep: 60_000,
  /** An unchanged state is sent again this often… */
  stateHeartbeat: 30 * 60_000,
  /** …plus a per-feature offset within this spread. */
  heartbeatSpread: 5 * 60_000,
  /** "Test the connection" waits this long for the session (the manifest allows 30 s). */
  testWait: 25_000,
  /** The time of the last connection attempt is written to /data at most this often. */
  attemptWrite: 60_000,
  /** At most one warning this often about the messages dropped. */
  dropLog: 60_000,
};
