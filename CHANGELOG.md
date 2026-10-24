# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Connection to a Sunricher DALI gateway (SR-GW-EDA, DALI Center) through the
  gateway's own MQTT server, locally: one session, the exact topics of the
  gateway serial number, spaced reconnections, keep alive; optional TLS with
  the certificate pinned on the first connection.
- The gateway's devices, groups and scenes, read at every connection and on
  "Scan" (once a minute at most), with the protocol of PySrDaliGateway 0.21.0.
- DALI lights: on/off, brightness, colour temperature (DT8 Tc) or colour (DT8
  RGB, XY, RGBW, RGBWA); DALI groups: on/off and brightness; scenes: a button
  to recall each one.
- Motion sensors (motion, occupancy) and light sensors (lux).
- DALI-2 push button panels as a scene trigger `panel_button` (panel, name,
  key, event, rotation).
- Commands of the same kind within 100 ms share one MQTT message; the states
  sent to Gladys stay within 240 per minute, lights and motion first.
- A pairing helper (`scripts/pair.mjs`, in the image) that shows the address,
  port, serial number, user name and password a gateway gives once its button
  is pressed.
- A "Test the connection" button.

[Unreleased]: https://github.com/LM1LC3N7/gladys-sunricher-dali/commits/main
