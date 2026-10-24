# Sunricher DALI for Gladys Assistant

External integration for [Gladys Assistant](https://gladysassistant.com):
**Sunricher DALI gateways** (SR-GW-EDA, configured with the DALI Center app),
**locally**, through the MQTT server built into the gateway. No cloud, no
other broker.

> **Never tested with a real gateway.** Unofficial, not affiliated with
> Sunricher.

- The devices, groups and scenes configured on the gateway, read at every
  connection.
- DALI lights: on/off, brightness, colour temperature (DT8 Tc) or colour (DT8
  RGB, XY, RGBW, RGBWA). DALI groups: on/off and brightness. Scenes: a button
  to recall each one.
- Motion sensors (motion, occupancy) and light sensors (lux).
- DALI-2 push button panels: a scene trigger (pressed, held, double pressed,
  turned, released).
- One MQTT session, only the topics of the configured serial number, bounded
  and validated messages, commands grouped in one message, at most 240 states
  per minute to Gladys.
- Pairing: the gateway gives its MQTT user name and password only when its
  button is pressed, to a request on the local network (UDP multicast), which
  cannot reach the container of an integration. A small command does it once:
  see the guide.

User guides: [français](docs/fr.md), [English](docs/en.md).

## Development

```bash
npm install
npm test               # node --test (Node 22 and 24), against a fake gateway on 127.0.0.1
npm run lint
npm run format:check
npm run audit          # npm audit --omit=dev
npm run pair           # the pairing helper (needs the gateway on your network)
node scripts/cover.mjs cover.png
```

Layout: `src/mqtt/` (MQTT 3.1.1 packets and the session), `src/dali/`
(the gateway messages), `src/app.js` (lists, states, scene events, commands),
`src/devices.js`, `src/publisher.js` (rate limits), `scripts/pair.mjs`
(pairing), `test/helpers/fakeGateway.js` (a fake gateway, plain or TLS). See
`CLAUDE.md` and `TODO.md`.

## Credits and licence

Apache-2.0 (`LICENSE`). The protocol is ported from
[PySrDaliGateway](https://github.com/maginawin/PySrDaliGateway) 0.21.0 by
Sunricher (Apache-2.0): see `THIRD_PARTY_NOTICES.md`.
