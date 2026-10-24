# TODO - Sunricher DALI v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `gi ci` (Prettier, ESLint, tests Node 22 and 24, Docker
  build, store validator), `npm run audit`, then update README, `docs/fr.md`,
  `docs/en.md`, `CHANGELOG.md` and this file.
- No forum topic of its own, no forum post from a module session (lot 15).
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 - core** (2026-10-24): own MQTT 3.1.1 client on
      `node:net` / `node:tls` (one session, exact topics, bounded packets,
      keep alive, TLS pin learnt before CONNECT); the gateway protocol ported
      from PySrDaliGateway 0.21.0 (device, group and scene lists, statuses,
      online status, writeDev / writeGroup / writeScene / readDev, batching);
      lights (on/off, brightness, colour temperature, colour), groups,
      scenes, motion and light sensors, panel keys as a scene trigger;
      publisher with a 240 states per minute budget; pairing helper
      `scripts/pair.mjs`; "Test the connection"; fr/en. Tested against a fake
      gateway (a real MQTT server on 127.0.0.1, plain and TLS) only.
- [ ] **Milestone 2 - real gateway**: run against an SR-GW-EDA; capture real
      messages (anonymised) as fixtures; fix what differs (see below).
- [ ] **Milestone 3 - more**: energy (reportEnergy / getEnergy, dpid 30: a
      cumulative Wh index for Home Assistant, so the guard of
      gladys-p1-monitor `src/guard.js` taken as is, never published raw),
      identify (identifyDev) as a button, sensor on/off and parameters, the
      gateway restart, several gateways (one integration per gateway today).
- [ ] **Milestone 4 - first release**: Docker image check, Release workflow,
      topic, GHCR package public.

## To check on a real gateway

- Whether the pairing answer goes to UDP port 50569 as unicast or multicast
  (the helper joins the group and listens on 50569, like PySrDaliGateway).
- Whether the gateway sends a `devStatus` after `writeDev` (the read back
  1.5 s later covers both cases).
- The `searchDevRes` of a large installation: several messages (status 2/3)
  or one; the integration accumulates until status 0 or 1.
- Whether `gwSn` is in every message (a message without it is accepted on the
  exact topic; one with another serial is dropped).
- The value types in the statuses (numbers, booleans, texts): parsed strictly.
- The brightness written as an integer 0-1000 (PySrDaliGateway writes a float
  `brightness * 1000 / 255`).
- The colour temperature range of real DT8 Tc drivers (Gladys offers 2000 K to
  6500 K, values outside are clamped on display, refused as commands).
- What the gateway does with a second MQTT client (DALI Center app, Home
  Assistant) at the same time.
- TLS gateways (`isMqttTls`): the port, whether the certificate is per gateway
  (pinned here) and signed by the Sunricher root of PySrDaliGateway
  (`certs/ca.crt`, not used: the pin is stricter).

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (`ghcr.io/lm1lc3n7/gladys-sunricher-dali:0.1.0`);
  the first patch release gives 0.1.1. `test/manifest.test.js` checks that
  they agree, never a fixed value.
- **No external broker**: the gateway is the MQTT broker
  (PySrDaliGateway connects to the gateway address with the credentials of
  the pairing). Nothing else to install.
- **Own MQTT client, no dependency**: the password goes in CONNECT, so the
  certificate must be checked before the first byte; an MQTT library would
  write CONNECT as soon as the socket opens. The few packets needed are
  written in `src/mqtt/packet.js`, every packet bounded (512 KB), the reader
  joins chunks once (no quadratic concatenation). Runtime dependency: the SDK
  only.
- **One session**: a generation number bumped at every end; listeners and
  timers of an older socket check it. A new client id per session
  (`gladys_dali_<random>`), never an app's.
- **Refused credentials**: CONNACK 4 or 5, or two sessions in a row closed
  (or unanswered) after CONNECT: final, persisted in `/data` with the place
  (`tcp|tls://host:port/serial`), no automatic retry. Lifted by a change of
  host, port, serial, user name, password, TLS or fingerprint, or by "Test
  the connection" once a session works (the button alone never clears it).
- **TLS**: optional (Home Assistant uses plain MQTT). The leaf certificate is
  pinned (SHA-256): typed in the configuration, or learnt on the first
  contact and written to `/data` before CONNECT (a failed write stops). A
  typed fingerprint is kept in `/data` too; emptying the field never relearns.
  The pin is keyed by the serial number (an IP change keeps it). A changed
  certificate stops, persisted, with the presented fingerprint in the status.
- **Pairing outside the container**: the gateway gives its credentials only to
  a UDP multicast request after its button is pressed; a bridge container
  never sees multicast, and the core's mediated scan cannot do it (broadcast
  only, answers collected on the emitting port, one scan at a time while the
  answer goes to port 50569). Hence `scripts/pair.mjs`, shipped in the image,
  run once with `--network host`. It prints the credentials to that terminal
  only. The request is exactly PySrDaliGateway's (`type: "HA"`, the fixed
  protocol key `SR-DALI-GW-HASYS`): a protocol convention published by the
  manufacturer under Apache-2.0, not an imitation of an application nor a
  secret.
- **Credentials never logged**: neither the user name nor the password is
  logged, written to `/data` or put in a status. The user name is a plain
  field (not secret) of the configuration, the password a secret field
  without default.
- **External ids** (frozen): `light|motion|illuminance:<serial>-<bus>-<address>`,
  `group:<serial>-<bus>-<group>`, `scene:<serial>-<bus>-<scene>`, serial in
  lower case. PySrDaliGateway also puts the DALI type in its id; not here, so
  a replaced driver of the same type keeps its device (a different type at an
  address is not applied until the lists are read again).
- **Lists, never a bus scan**: `searchDev` with `searchFlag: "exited"` (the
  gateway's list); the physical bus scan (`busDevice`, up to 10 minutes) is
  not offered, its answers are ignored.
- **Commands**: acked once written to the gateway (lighting, low risk; the
  gateway gives no answer tied to a command); read back 1.5 s later (one
  batched `readDev`). Refused, nothing sent: not connected, too late (3.5 s),
  unknown device, bad value, read only. A brightness above 0 also sends power
  on (PySrDaliGateway `turn_on`), 0 sends power off. Colour temperature and
  colour do not turn the light on.
- **Batching**: `writeDev` and `readDev` entries within 100 ms share one
  message (32 entries per message), properties of the same device merged by
  data point (PySrDaliGateway `add_request`). Groups and scenes are one
  message each.
- **States budget**: one publisher for the gateway, 240 states per minute
  (the core admits 300), 60 of them kept for lights and motion; light levels
  wait. Scene events (panel keys) 120 per minute, refused at the entry over
  it. Heartbeat of unchanged values every 30 minutes.
- **Group state**: derived from the members (on if one is on, off if all are
  off, unknown otherwise); the gateway has none.
- **Motion**: `motion` (motion-sensor) on MOTION, off on NO_MOTION;
  `occupancy` (presence-sensor) on MOTION, OCCUPANCY, PRESENCE, off on
  VACANT, as Home Assistant. An unknown data point is dropped (PySrDaliGateway
  maps it to "no motion").
- **Illuminance**: 0 < lux <= 1000, else ignored (PySrDaliGateway marks it
  invalid).
- **Energy not in v1**: the gateway reports a cumulative Wh index; it needs the
  index guard of gladys-p1-monitor. Milestone 3.
- **Messages**: validated strictly (strict integers, DALI ranges, a known
  command, `gwSn` equal to the configured serial when present, bounded lists
  and names, control characters removed); 1,000 messages per 10 s at most.
- **Restart spacing**: the time of the last attempt is in `/data` (written at
  most once a minute, and at the first attempt of a process); a start waits
  until 10 s after it.
- **Status and Discovery at every `connected`**: the status cache, the
  published devices and transports are forgotten and sent again.
