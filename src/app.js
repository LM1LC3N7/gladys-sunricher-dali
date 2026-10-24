// -----------------------------------------------------------------------------
// The integration: one MQTT session with the Sunricher DALI gateway
// (src/mqtt/client.js), what the gateway says about its devices, groups and
// scenes (src/dali/protocol.js), the Gladys devices and states
// (src/devices.js), the panel scene events, the commands. index.js only wires
// the SDK handlers to it.
//
// - At every session the gateway is asked for its devices, groups and scenes
//   (the gateway's own list, never a scan of the DALI bus), then every light
//   is read; the status pushes of the gateway keep the states up to date.
// - Gladys gets the changes once per turn of the event loop, through one
//   publisher with a per-minute budget (src/publisher.js).
// - Commands of the same kind written within 100 ms share one MQTT message
//   (PySrDaliGateway batching); a command is acked once written to the
//   gateway, never "not sent" once it may have left; the device is read back
//   1.5 s later. The ack never waits for the publication of the states.
// - The user name and password are never logged.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig, placeKey, sessionKey } from './config.js';
import { LIMITS, SCENE_TRIGGERS, TIMINGS } from './constants.js';
import {
  brightnessProperty,
  colorProperty,
  deviceKey,
  isIlluminance,
  isLight,
  isMotion,
  isPanel,
  message,
  parseIlluminance,
  parseLight,
  parseMessage,
  parseMotion,
  parsePanel,
  powerProperty,
  publishTopic,
  subscribeTopic,
  temperatureProperty,
} from './dali/protocol.js';
import {
  MIRED,
  buildDevices,
  buildStates,
  deviceKind,
  idsOf,
  lightFeatureKeys,
  parseFeatureId,
} from './devices.js';
import { COMMAND_NAMES, T, fill, word } from './i18n.js';
import { MqttSession, colons } from './mqtt/client.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory } from './store.js';

/** A command refused before anything was sent to the gateway. */
export class Refused extends Error {}

const emptyModel = (serial = '') => ({
  serial,
  devices: new Map(),
  groups: new Map(),
  scenes: new Map(),
  version: undefined,
});

/** A strict number from Gladys (null, '' or text are not numbers). */
function numberOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d{1,9}(\.\d{1,6})?$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

export class DaliApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'sunricher-dali' }),
    session,
    connect,
    now = Date.now,
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.session = session ?? new MqttSession({ connect, timers, now, logger });
    this.session.learn = (fingerprint) => this.learnCertificate(fingerprint);
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.key = undefined;
    this.model = emptyModel();
    this.online = false;
    this.memory = undefined;
    this.lastStatus = undefined;
    this.lastTransports = undefined;
    this.published = undefined;
    this.started = false;
    this.sweeper = undefined;
    this.readBackTimer = undefined;
    this.readBackKeys = new Set();
    this.starting = Promise.resolve();
    this.pendingEvents = [];
    this.flushScheduled = false;
    this.waiters = new Set();
    this.batches = new Map();
    this.refreshing = undefined;
    this.lastRefreshAt = -Infinity;
    this.partial = [];
    this.answered = false;
    this.window = { at: 0, count: 0, dropped: 0, loggedAt: undefined };
    this.attemptWrittenAt = -Infinity;
    this.session.on('attempt', () => this.noteAttempt());
    this.session.on('up', (info) => {
      this.online = true;
      // What a session knows starts unknown at every session.
      this.answered = false;
      this.partial = [];
      this.guard(() => this.onUp(info));
    });
    this.session.on('down', (info) => {
      const wasOnline = this.online;
      this.online = false;
      this.answered = false;
      this.failWaiters();
      this.failBatches();
      this.guard(() => this.onDown(info, wasOnline));
    });
    // Applied at once, in the order of the gateway.
    this.session.on('message', ({ payload }) => this.onMessage(payload));
  }

  /** What talks to Gladys runs one after the other, in order. */
  guard(fn) {
    this.chain = (this.chain ?? Promise.resolve())
      .then(fn)
      .catch((err) => this.logger.error(`DALI event failed: ${err.message}`));
    return this.chain;
  }

  get language() {
    return this.config.language;
  }

  error(entry, cause) {
    return new Error(word(entry, this.language), cause ? { cause } : undefined);
  }

  refused(entry) {
    return new Refused(word(entry, this.language));
  }

  // --- Memory (/data) ----------------------------------------------------------

  async loadMemory() {
    if (this.memory) return this.memory;
    try {
      this.memory = normalizeMemory(await this.store.load());
    } catch {
      this.memory = normalizeMemory(null);
    }
    return this.memory;
  }

  async saveMemory() {
    try {
      await this.store.save(this.memory);
      return true;
    } catch (err) {
      this.logger.warn(`Saving the state to /data failed: ${err.message}`);
      return false;
    }
  }

  /** The time of the attempt, in /data at most once a minute (before the attempt goes on). */
  noteAttempt() {
    const now = this.now();
    if (!this.memory) return;
    this.memory.lastAttemptAt = now;
    if (now - this.attemptWrittenAt < TIMINGS.attemptWrite) return;
    this.attemptWrittenAt = now;
    this.saveMemory();
  }

  /** The pin of this gateway: typed in the configuration, else kept in /data. */
  pinned() {
    if (this.config.fingerprint) return this.config.fingerprint;
    const pin = this.memory?.pin;
    return pin && pin.place === this.config.serial ? pin.fingerprint : '';
  }

  /** First contact over TLS: the fingerprint is kept in /data before the password leaves. */
  async learnCertificate(fingerprint) {
    const memory = await this.loadMemory();
    memory.pin = { place: this.config.serial, fingerprint };
    if (!(await this.saveMemory())) return false;
    this.logger.info(
      `DALI gateway: certificate pinned on first contact, SHA-256 ${colons(fingerprint)}`,
    );
    return true;
  }

  // --- Lifecycle -------------------------------------------------------------

  /** Starts (or restarts); two starts never overlap (no leaked timer). */
  start(raw = {}) {
    const run = this.starting.then(() => this.startNow(raw));
    this.starting = run.catch(() => undefined);
    return run;
  }

  async startNow(raw = {}) {
    this.stop();
    const next = normalizeConfig(raw);
    if (next.serial !== this.model.serial) this.model = emptyModel(next.serial);
    this.config = next;
    this.key = sessionKey(next);
    this.online = false;
    this.lastRefreshAt = -Infinity;
    const memory = await this.loadMemory();
    if (next.serial && next.fingerprint) {
      // A typed fingerprint is kept too: emptying the field never relearns blindly.
      const pin = memory.pin;
      if (!pin || pin.place !== next.serial || pin.fingerprint !== next.fingerprint) {
        memory.pin = { place: next.serial, fingerprint: next.fingerprint };
        await this.saveMemory();
      }
    }
    await this.publishDevices();
    await this.publishStates();
    const problem = this.configProblem();
    if (problem) {
      await this.setStatus(false, problem);
      return;
    }
    if (memory.stop && memory.stop.place === placeKey(next)) {
      this.logger.warn(
        `DALI gateway: stopped before (${memory.stop.kind}): no connection until the configuration changes or "Test the connection" is clicked`,
      );
      await this.setStatus(false, this.stopMessage(memory.stop.kind, memory.stop.presented));
      return;
    }
    await this.setStatus(false, T.connecting);
    this.connect();
    this.startSweeper();
  }

  stopMessage(kind, presented, pinned) {
    if (kind === 'certificate_changed') {
      return fill(T.certificate, colons(presented), colons(pinned ?? this.pinned()));
    }
    return T.refused;
  }

  /** Connects, never sooner than the spacing after the last attempt (a restart loop). */
  connect() {
    const { config } = this;
    this.session.configure({
      host: config.host,
      port: config.port,
      tls: config.tls,
      username: config.username,
      password: config.password,
      fingerprint: config.tls ? this.pinned() : '',
      topic: subscribeTopic(config.serial),
      publishTopic: publishTopic(config.serial),
    });
    const since = this.now() - (this.memory?.lastAttemptAt ?? 0);
    const delay = since >= 0 && since < TIMINGS.backoff[0] ? TIMINGS.backoff[0] - since : 0;
    this.session.start({ delay });
  }

  startSweeper() {
    if (this.sweeper) this.timers.clearInterval(this.sweeper);
    this.sweeper = this.timers.setInterval(
      () => this.guard(() => this.publishStates()),
      TIMINGS.sweep,
    );
  }

  stop() {
    this.session.stop();
    this.online = false;
    this.publisher.stop();
    this.failWaiters();
    this.failBatches();
    if (this.sweeper) {
      this.timers.clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
    if (this.readBackTimer) this.timers.clearTimeout(this.readBackTimer);
    this.readBackTimer = undefined;
    this.readBackKeys.clear();
  }

  /** Clean shutdown: the session closed, /data written. */
  async shutdown() {
    this.stop();
    if (this.memory) await this.saveMemory();
  }

  configProblem() {
    const c = this.config;
    if (!c.hostTyped) return T.noHost;
    if (!c.host) return T.badHost;
    if (!c.serialTyped) return T.noSerial;
    if (!c.serial) return T.badSerial;
    if (c.usernameInvalid || c.passwordInvalid) return T.badCredentials;
    if (!c.username || !c.password) return T.noCredentials;
    if (c.fingerprintInvalid) return T.badFingerprint;
    return undefined;
  }

  /** First connection to Gladys: start; a reconnection (Gladys restarted): resend everything. */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    // Gladys keeps the connection status and the discovered devices in memory.
    this.published = undefined;
    this.lastTransports = undefined;
    const status = this.lastStatus;
    this.lastStatus = undefined;
    await this.configUpdated(raw);
    if (status && this.lastStatus === undefined) {
      const [connected, text] = JSON.parse(status);
      await this.setStatus(connected, text ?? undefined);
    }
    this.publisher.forget();
    await this.publishDevices();
    await this.publishStates();
    await this.publishTransports();
  }

  /** New place or credentials reconnect (and lift a stop); the rest applies at once. */
  async configUpdated(raw = {}) {
    const next = normalizeConfig(raw);
    if (sessionKey(next) !== this.key) {
      await this.liftStop();
      return this.start(raw);
    }
    this.config = next;
    await this.publishDevices();
    await this.publishStates();
    if (this.online && !this.refreshing) await this.setStatus(true, this.onlineMessage());
    return undefined;
  }

  async liftStop() {
    const memory = await this.loadMemory();
    if (!memory.stop) return;
    memory.stop = null;
    await this.saveMemory();
  }

  async setStatus(connected, text) {
    const key = JSON.stringify([connected, text ?? null]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, text)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  counts() {
    let lights = 0;
    let sensors = 0;
    for (const device of this.model.devices.values()) {
      if (isLight(device.devType)) lights += 1;
      else if (deviceKind(device.devType)) sensors += 1;
    }
    return { lights, sensors, groups: this.model.groups.size, scenes: this.model.scenes.size };
  }

  onlineMessage() {
    if (!this.answered) return T.noAnswer;
    const { lights, sensors, groups, scenes } = this.counts();
    const extra = {};
    for (const lang of ['en', 'fr']) {
      let text = '';
      if (this.partial.length > 0) text += word(T.partial, lang)(this.partial.join(', '));
      if (!this.config.tls) text += word(T.plain, lang);
      extra[lang] = text;
    }
    return {
      en: word(T.connected, 'en')(lights, sensors, groups, scenes, extra.en),
      fr: word(T.connected, 'fr')(lights, sensors, groups, scenes, extra.fr),
    };
  }

  // --- Session events --------------------------------------------------------

  async onUp() {
    // The test button lifts a stop only once a session works.
    const memory = await this.loadMemory();
    if (memory.stop) {
      memory.stop = null;
      await this.saveMemory();
    }
    await this.publishTransports();
    await this.setStatus(true, T.reading);
    // Outside the event chain: the status pushes and the commands go on meanwhile.
    this.refresh({ force: true });
  }

  async onDown({ reason, retryIn, refused, silent, certificate, presented, pinned }, wasOnline) {
    const seconds = Math.round((retryIn ?? 0) / 1000);
    if (refused || silent || certificate) {
      const kind = certificate ? 'certificate_changed' : 'credentials_refused';
      this.logger.error(`DALI gateway: connection stopped (${reason}), no new try`);
      const memory = await this.loadMemory();
      memory.stop = {
        place: placeKey(this.config),
        kind,
        at: this.now(),
        // Public data: kept so the status still shows it after a restart.
        ...(certificate && presented ? { presented } : {}),
      };
      await this.saveMemory();
      await this.setStatus(false, this.stopMessage(kind, presented, pinned));
    } else {
      this.logger.warn(`DALI gateway: ${reason}; next try in ${seconds} s`);
      await this.setStatus(false, fill(T.unreachable, reason, seconds));
    }
    if (wasOnline || this.lastTransports !== undefined) await this.publishTransports();
  }

  /** A message on the topic of this gateway, applied at once. */
  onMessage(payload) {
    if (!this.countMessage()) return;
    const event = parseMessage(payload, this.config.serial);
    if (event.ignored) {
      this.logger.debug(`DALI gateway: message ignored (${event.ignored})`);
      return;
    }
    this.answered = true;
    if (event.kind === 'status') this.applyStatus(event);
    else if (event.kind === 'online') this.applyOnline(event);
    else if (event.kind === 'version') this.model.version = event;
    for (const waiter of [...this.waiters]) waiter.offer(event);
  }

  /** At most LIMITS.maxMessagesPer10s messages per 10 s; more are dropped (counted). */
  countMessage() {
    const now = this.now();
    const w = this.window;
    if (now - w.at >= 10_000) {
      w.at = now;
      w.count = 0;
    }
    w.count += 1;
    if (w.count <= LIMITS.maxMessagesPer10s) return true;
    w.dropped += 1;
    if (w.loggedAt === undefined || now - w.loggedAt >= TIMINGS.dropLog) {
      w.loggedAt = now;
      this.logger.warn(`DALI gateway: too many messages, ${w.dropped} dropped so far`);
    }
    return false;
  }

  applyStatus({ ref, properties }) {
    const key = deviceKey(ref);
    if (isPanel(ref.devType)) {
      // Panel keys: scene triggers, bounded at the entry.
      const name = this.model.devices.get(key)?.name ?? '';
      const events = [];
      for (const press of parsePanel(properties)) {
        if (this.publisher.reserveEvent()) events.push({ ref, name, ...press });
      }
      if (events.length > 0) this.noteChange(events);
      return;
    }
    const device = this.model.devices.get(key);
    // Unknown here, or another type at this address (a replaced driver): not
    // applied until the next reading of the gateway's list.
    if (!device || device.devType !== ref.devType) return;
    if (isLight(ref.devType)) {
      const status = parseLight(properties);
      if (Object.keys(status).length === 0) return;
      device.status = { ...device.status, ...status };
    } else if (isMotion(ref.devType)) {
      const events = parseMotion(properties);
      if (events.length === 0) return;
      for (const event of events) {
        if (event === 'motion') {
          device.motion = true;
          device.occupancy = true;
        } else if (event === 'no_motion') device.motion = false;
        else if (event === 'occupancy' || event === 'presence') device.occupancy = true;
        else if (event === 'vacant') device.occupancy = false;
      }
    } else if (isIlluminance(ref.devType)) {
      const lux = parseIlluminance(properties);
      if (lux === undefined) return;
      device.lux = lux;
    } else return;
    this.noteChange([]);
  }

  applyOnline({ entries }) {
    let changed = false;
    for (const { ref, online } of entries) {
      const device = this.model.devices.get(deviceKey(ref));
      if (!device || device.devType !== ref.devType || device.online === online) continue;
      device.online = online;
      changed = true;
    }
    if (changed) this.guard(() => this.publishTransports());
  }

  noteChange(events) {
    this.pendingEvents.push(...events);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      this.guard(() => this.flushChanges());
    });
  }

  async flushChanges() {
    const events = this.pendingEvents.splice(0);
    await this.publishStates();
    for (const { ref, name, key, event, rotate } of events) {
      await this.publisher.sceneEvent(
        SCENE_TRIGGERS.PANEL_BUTTON,
        {
          panel: `${ref.channel}-${ref.address}`,
          name,
          button: key,
          event,
          rotate: rotate ?? null,
        },
        { reserved: true },
      );
    }
  }

  // --- Requests to the gateway -------------------------------------------------

  /** Waits for an event that `match` accepts (events received from now on only). */
  waitFor(match, timeout) {
    let waiter;
    const promise = new Promise((resolve, reject) => {
      waiter = {
        offer: (event) => {
          let value;
          try {
            value = match(event);
          } catch {
            value = undefined;
          }
          if (value !== undefined) waiter.done(value);
        },
        done: (value) => {
          this.timers.clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          resolve(value);
        },
        fail: (err) => {
          this.timers.clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          reject(err);
        },
      };
      waiter.timer = this.timers.setTimeout(() => waiter.fail(new Error('timeout')), timeout);
      this.waiters.add(waiter);
    });
    return { promise, cancel: () => waiter.fail(new Error('cancelled')) };
  }

  failWaiters() {
    for (const waiter of [...this.waiters]) waiter.fail(new Error('the session ended'));
  }

  /** Publishes one message now; false when nothing could be written. */
  send(cmd, fields = {}) {
    if (!this.session.connected) return false;
    return this.session.publish(message(this.config.serial, cmd, fields, this.now()));
  }

  /** Sends `cmd` and waits for the answer `match` accepts; undefined on no answer. */
  async ask(cmd, fields, match, timeout) {
    const wait = this.waitFor(match, timeout);
    if (!this.send(cmd, fields)) {
      wait.cancel();
      await wait.promise.catch(() => undefined);
      return undefined;
    }
    return wait.promise.catch(() => undefined);
  }

  /**
   * Reads the gateway's list of devices, groups and scenes (one reading at a
   * time, "Scan" at most once a minute), then reads every light.
   */
  refresh({ force = false } = {}) {
    if (this.refreshing) return this.refreshing;
    if (!force && this.now() - this.lastRefreshAt < TIMINGS.scanInterval) return Promise.resolve();
    this.lastRefreshAt = this.now();
    const generation = this.session.generation;
    const current = () => generation === this.session.generation && this.session.connected;
    const run = (async () => {
      const partial = [];
      this.ask(
        'getVersion',
        {},
        (e) => (e.kind === 'version' ? e : undefined),
        TIMINGS.readTimeout,
      );
      // Devices: the answer may come in several messages, until its status says done.
      const found = new Map();
      const search = await this.ask(
        'searchDev',
        { searchFlag: 'exited' },
        (e) => {
          if (e.kind !== 'search') return undefined;
          for (const device of e.devices) {
            if (found.size < LIMITS.maxDevices) found.set(deviceKey(device), device);
          }
          return e.done ? true : undefined;
        },
        TIMINGS.listTimeout,
      );
      if (!current()) return;
      if (!search) partial.push('devices');
      const groupList = await this.ask(
        'getGroup',
        { getFlag: 'exited' },
        (e) => (e.kind === 'groups' ? e.groups : undefined),
        TIMINGS.listTimeout,
      );
      if (!current()) return;
      const groups = new Map();
      if (!groupList) partial.push('groups');
      else {
        const queue = groupList.slice(0, LIMITS.maxGroups);
        const readOne = async () => {
          while (queue.length > 0 && current()) {
            const { channel, id, name } = queue.shift();
            const read = await this.ask(
              'readGroup',
              { channel, groupId: id },
              (e) => (e.kind === 'group' && e.channel === channel && e.id === id ? e : undefined),
              TIMINGS.readTimeout,
            );
            groups.set(`${channel}-${id}`, {
              channel,
              id,
              name: read?.name || name,
              members: read ? read.members.map(deviceKey) : undefined,
            });
          }
        };
        await Promise.all(Array.from({ length: LIMITS.concurrentReads }, readOne));
        if ([...groups.values()].some((g) => g.members === undefined))
          partial.push('group members');
      }
      if (!current()) return;
      const sceneList = await this.ask(
        'getScene',
        { getFlag: 'exited' },
        (e) => (e.kind === 'scenes' ? e.scenes : undefined),
        TIMINGS.listTimeout,
      );
      if (!current()) return;
      if (!sceneList) partial.push('scenes');
      this.applyLists({
        devices: search ? found : undefined,
        groups: groupList ? groups : undefined,
        scenes: sceneList ? sceneList.slice(0, LIMITS.maxScenes) : undefined,
      });
      this.partial = partial;
      await this.guard(async () => {
        await this.publishDevices();
        await this.publishStates();
        await this.publishTransports({ force: true });
      });
      // Every light read once (batched), for its state now.
      for (const device of this.model.devices.values()) {
        if (isLight(device.devType)) this.queueRead(device);
      }
    })();
    this.refreshing = run
      .catch((err) => this.logger.warn(`DALI gateway: reading the lists failed: ${err.message}`))
      .finally(async () => {
        this.refreshing = undefined;
        if (this.session.connected && generation === this.session.generation) {
          await this.guard(() => this.setStatus(true, this.onlineMessage()));
        }
      });
    return this.refreshing;
  }

  /** The lists read (synchronous: no message comes in between); a part not read keeps the old one. */
  applyLists({ devices, groups, scenes }) {
    if (devices) {
      const next = new Map();
      for (const [key, found] of devices) {
        const old = this.model.devices.get(key);
        const kept = old && old.devType === found.devType ? old : {};
        next.set(key, { ...kept, ...found, status: kept.status ?? {}, online: kept.online });
      }
      this.model.devices = next;
    }
    if (groups) this.model.groups = groups;
    if (scenes) {
      this.model.scenes = new Map(scenes.map((s) => [`${s.channel}-${s.id}`, s]));
    }
    const { lights, sensors } = this.counts();
    this.logger.info(
      `DALI gateway: ${lights} light(s), ${sensors} sensor(s), ${this.model.groups.size} group(s), ${this.model.scenes.size} scene(s)`,
    );
  }

  // --- Batched commands (PySrDaliGateway add_request / _flush_batch) -------------

  /**
   * Queues one entry of a batched command (writeDev, readDev); entries of the
   * same device merge (a property of the same data point is replaced). Resolves
   * once the message carrying it is written; rejects (nothing sent) otherwise.
   */
  batch(cmd, device, entry) {
    return new Promise((resolve, reject) => {
      if (!this.session.connected) {
        reject(this.refused(T.offline));
        return;
      }
      if (!this.batches.has(cmd)) this.batches.set(cmd, { entries: new Map(), timer: undefined });
      const pending = this.batches.get(cmd);
      const key = deviceKey(device);
      const old = pending.entries.get(key);
      if (old && old.data.property && entry.property) {
        const merged = new Map(old.data.property.map((p) => [p.dpid, p]));
        for (const p of entry.property) merged.set(p.dpid, p);
        old.data = { ...entry, property: [...merged.values()] };
        old.waiters.push({ resolve, reject });
      } else {
        pending.entries.set(key, { data: entry, waiters: [{ resolve, reject }] });
      }
      if (!pending.timer) {
        pending.timer = this.timers.setTimeout(() => this.flushBatch(cmd), TIMINGS.batchWindow);
      }
    });
  }

  flushBatch(cmd) {
    const pending = this.batches.get(cmd);
    if (!pending) return;
    this.batches.delete(cmd);
    if (pending.timer) this.timers.clearTimeout(pending.timer);
    const entries = [...pending.entries.values()];
    for (let i = 0; i < entries.length; i += LIMITS.batchSize) {
      const part = entries.slice(i, i + LIMITS.batchSize);
      const written = this.send(cmd, { data: part.map((e) => e.data) });
      for (const entry of part) {
        for (const waiter of entry.waiters) {
          if (written) waiter.resolve();
          else waiter.reject(this.refused(T.offline));
        }
      }
    }
  }

  failBatches() {
    for (const [cmd, pending] of [...this.batches]) {
      this.batches.delete(cmd);
      if (pending.timer) this.timers.clearTimeout(pending.timer);
      for (const entry of pending.entries.values()) {
        for (const waiter of entry.waiters) waiter.reject(this.refused(T.offline));
      }
    }
  }

  queueRead(device) {
    this.batch('readDev', device, {
      devType: device.devType,
      channel: device.channel,
      address: device.address,
    }).catch(() => undefined);
  }

  /** The devices read back after a command, together, 1.5 s after the last one. */
  scheduleReadBack(keys) {
    for (const key of keys) this.readBackKeys.add(key);
    if (this.readBackTimer) this.timers.clearTimeout(this.readBackTimer);
    this.readBackTimer = this.timers.setTimeout(() => {
      this.readBackTimer = undefined;
      const keys = [...this.readBackKeys];
      this.readBackKeys.clear();
      if (!this.session.connected) return;
      for (const key of keys) {
        const device = this.model.devices.get(key);
        if (device) this.queueRead(device);
      }
    }, TIMINGS.readBack);
  }

  // --- Gladys ----------------------------------------------------------------

  hasEntries() {
    const m = this.model;
    return m.devices.size + m.groups.size + m.scenes.size > 0;
  }

  async publishDevices({ force = false } = {}) {
    if (!this.hasEntries() || !this.model.serial) return;
    const devices = buildDevices(this.gladys, this.config, this.model);
    const json = JSON.stringify(devices);
    if (json === this.published && !force) return;
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the devices failed: ${err.message}`);
    }
  }

  publishStates() {
    if (!this.hasEntries() || !this.model.serial) return Promise.resolve();
    return this.publisher.publish(buildStates(this.gladys, this.model));
  }

  /** Local when the session is up and the device online; unreachable otherwise. */
  async publishTransports({ force = false } = {}) {
    if (!this.hasEntries() || !this.model.serial) return;
    const devices = buildDevices(this.gladys, this.config, this.model);
    const offline = new Set();
    for (const device of this.model.devices.values()) {
      if (device.online === false) {
        const kind = deviceKind(device.devType);
        if (kind) {
          offline.add(
            idsOf(this.gladys, kind, this.model.serial, device.channel, device.address).device,
          );
        }
      }
    }
    const entries = devices.map((device) => ({
      external_id: device.external_id,
      transport:
        this.online && !offline.has(device.external_id)
          ? DEVICE_TRANSPORTS.LOCAL
          : DEVICE_TRANSPORTS.UNREACHABLE,
    }));
    const json = JSON.stringify(entries);
    if (json === this.lastTransports && !force) return;
    try {
      // At most 100 entries per request.
      for (let i = 0; i < entries.length; i += 100) {
        await this.gladys.publishTransports(entries.slice(i, i + 100));
      }
      this.lastTransports = json;
    } catch (err) {
      this.logger.warn(`Publishing the transports failed: ${err.message}`);
    }
  }

  /** "Scan" in Gladys: the devices sent again, the gateway's lists read again (once a minute at most). */
  async scan() {
    await this.publishDevices({ force: true });
    if (this.session.connected) this.refresh();
  }

  /** The user created or updated a device: Gladys has none of its states yet, send them again. */
  async deviceChanged(device) {
    this.publisher.forget(device?.external_id);
    await this.publishStates();
  }

  // --- Commands --------------------------------------------------------------

  async setValue(_device, feature, value) {
    const asked = this.now();
    const target = parseFeatureId(feature?.external_id);
    if (!target || target.serial !== this.config.serial.toLowerCase()) {
      throw this.refused(T.unknownDevice);
    }
    const { kind, channel, number, key } = target;
    const shown = `${channel}-${number}`;
    if (kind === 'motion' || kind === 'illuminance') throw this.refused(T.readOnly);
    if (!this.session.connected) {
      this.logger.warn(`Command NOT sent (${kind} ${shown}): not connected`);
      throw this.refused(T.offline);
    }
    const numeric = numberOf(value);
    const bad = () => this.refused(fill(T.badValue, JSON.stringify(value)));
    if (kind === 'scene') {
      const scene = this.model.scenes.get(shown);
      if (!scene || key !== 'activate') throw this.refused(T.unknownDevice);
      if (numeric !== 1) throw bad();
      this.logger.info(`Command from Gladys: ${word(fill(COMMAND_NAMES.scene, shown), 'en')}`);
      this.checkDeadline(asked);
      if (!this.send('writeScene', { channel, sceneId: number })) throw this.refused(T.offline);
      this.scheduleReadBack(this.lightsOf(channel));
      return;
    }
    const properties = this.properties(kind, key, numeric, bad, shown);
    if (kind === 'group') {
      const group = this.model.groups.get(shown);
      if (!group) throw this.refused(T.unknownDevice);
      this.checkDeadline(asked);
      if (!this.send('writeGroup', { channel, groupId: number, data: properties })) {
        throw this.refused(T.offline);
      }
      this.scheduleReadBack(group.members ?? this.lightsOf(channel));
      return;
    }
    const device = this.model.devices.get(shown);
    if (!device || !isLight(device.devType) || !lightFeatureKeys(device.devType).includes(key)) {
      throw this.refused(T.unknownDevice);
    }
    this.checkDeadline(asked);
    await this.batch('writeDev', device, {
      devType: device.devType,
      channel: device.channel,
      address: device.address,
      property: properties,
    });
    this.scheduleReadBack([shown]);
  }

  checkDeadline(asked) {
    if (this.now() > asked + TIMINGS.sendBy) throw this.refused(T.tooLate);
  }

  lightsOf(channel) {
    return [...this.model.devices.values()]
      .filter((d) => d.channel === channel && isLight(d.devType))
      .map(deviceKey);
  }

  /** The properties of a light or group command, validated strictly. */
  properties(kind, key, numeric, bad, shown) {
    if (key === 'binary') {
      if (numeric !== 0 && numeric !== 1) throw bad();
      this.logger.info(
        `Command from Gladys: ${kind} ${word(fill(COMMAND_NAMES.power, shown, numeric === 1), 'en')}`,
      );
      return [powerProperty(numeric === 1)];
    }
    if (key === 'brightness') {
      if (numeric === undefined || numeric < 0 || numeric > 100) throw bad();
      const percent = Math.round(numeric);
      this.logger.info(
        `Command from Gladys: ${kind} ${word(fill(COMMAND_NAMES.brightness, shown, percent), 'en')}`,
      );
      // A level above 0 also turns the light on (PySrDaliGateway turn_on); 0 turns it off.
      return percent === 0
        ? [powerProperty(false)]
        : [powerProperty(true), brightnessProperty(percent)];
    }
    if (key === 'temperature' && kind === 'light') {
      if (numeric === undefined || numeric < MIRED.min || numeric > MIRED.max) throw bad();
      const prop = temperatureProperty(numeric);
      this.logger.info(
        `Command from Gladys: light ${word(fill(COMMAND_NAMES.temperature, shown, prop.value), 'en')}`,
      );
      return [prop];
    }
    if (key === 'color' && kind === 'light') {
      if (
        numeric === undefined ||
        !Number.isInteger(numeric) ||
        numeric < 0 ||
        numeric > 0xffffff
      ) {
        throw bad();
      }
      this.logger.info(
        `Command from Gladys: light ${word(fill(COMMAND_NAMES.color, shown, numeric.toString(16).padStart(6, '0')), 'en')}`,
      );
      return [colorProperty(numeric)];
    }
    throw this.refused(T.unknownDevice);
  }

  // --- Configuration button ----------------------------------------------------

  /** Waits for the session to come up or go down, at most `timeout` ms. */
  waitForLink(timeout) {
    if (this.session.connected) return Promise.resolve('up');
    return new Promise((resolve) => {
      const done = (result) => {
        this.session.off('up', onUp);
        this.session.off('down', onDown);
        this.timers.clearTimeout(timer);
        resolve(result);
      };
      const onUp = () => done('up');
      const onDown = () => done('down');
      const timer = this.timers.setTimeout(() => done('timeout'), timeout);
      this.session.on('up', onUp);
      this.session.on('down', onDown);
    });
  }

  /**
   * "Test the connection": one try when no session is open (stopped, or
   * waiting for its next try), else waits for the one in progress. A stop
   * after refused credentials is lifted only once the session works.
   */
  async testConnection() {
    const problem = this.configProblem();
    if (problem) throw this.error(problem);
    const until = this.now() + TIMINGS.testWait;
    if (!this.session.connected && !this.session.busy) {
      await this.setStatus(false, T.connecting);
      this.connect();
      if (!this.sweeper) this.startSweeper();
    }
    const result = await this.waitForLink(TIMINGS.testWait);
    await this.chain;
    if (result === 'timeout') throw this.error(T.stillConnecting);
    if (result !== 'up') {
      const [, text] = this.lastStatus ? JSON.parse(this.lastStatus) : [];
      throw this.error(text ?? T.offline);
    }
    if (this.refreshing) {
      let timer;
      const left = Math.max(0, until - this.now());
      const outcome = await Promise.race([
        this.refreshing.then(() => 'done'),
        new Promise((resolve) => {
          timer = this.timers.setTimeout(() => resolve('timeout'), left);
        }),
      ]);
      this.timers.clearTimeout(timer);
      if (outcome === 'timeout') throw this.error(T.stillReading);
    }
    return this.onlineMessage();
  }
}
