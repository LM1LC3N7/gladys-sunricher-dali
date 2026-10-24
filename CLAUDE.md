# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official template and drives
**Sunricher DALI gateways** (SR-GW-EDA) through the MQTT server built into the
gateway, with the protocol of PySrDaliGateway 0.21.0 (Apache-2.0, see
`THIRD_PARTY_NOTICES.md`).

```
index.js                          SDK wiring only
src/handlers.js                   the SDK handlers -> the app (shared with the tests)
src/app.js                        lists, states, scene events, commands, statuses
src/mqtt/packet.js                the MQTT 3.1.1 packets, a bounded reader
src/mqtt/client.js                the one MQTT session (TLS pin before CONNECT)
src/dali/protocol.js              the gateway messages: builders and strict parsers
src/devices.js                    model -> Gladys devices and states (pure)
src/publisher.js                  states and scene events within the host API limits
src/store.js                      /data: stop after refused credentials, TLS pin, last attempt
src/config.js                     DEFAULTS (mirror the manifest defaults) + normalization
src/constants.js, src/i18n.js     keys, data points, limits, timings; French and English texts
scripts/pair.mjs                  pairing helper (in the image, run with --network host)
scripts/cover.mjs                 generates cover.png (dev only, not in the image)
gladys-assistant-integration.json manifest: name, config_schema, actions, triggers, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, the SDK's fake Gladys + test/helpers/fakeGateway.js
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

Safety rules of this integration (see TODO.md "Decisions"): one MQTT session;
only the exact topic of the configured serial number, messages with another
`gwSn` dropped; every message bounded and validated; the user name and the
password are never logged, written to `/data` or shown; with TLS the
certificate is pinned and checked before the password leaves; refused
credentials stop the connection, never a loop; at most 240 states per minute
to Gladys; a command is never reported "not sent" once it may have left; the
ack never waits for the publication; Maps only for what the gateway names (no
prototype pollution).

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the unique id the
  platform gives the device (here serial, bus, address), never a label.
  Gladys keys devices, their history, scenes and dashboards on them: changing
  one creates a new device and orphans the old one. The same goes for every
  key users store: manifest `config_schema`, `actions`, scene trigger keys,
  feature keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log tokens, passwords or user names.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language. A secret
  field never has a `default`. `test/manifest.test.js` ties the manifest to the
  code: change both sides together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync. A secret
  field is "kept by Gladys in its database, never shown again", never said to
  be protected by a cipher.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network beyond 127.0.0.1.
