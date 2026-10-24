# Sunricher DALI for Gladys Assistant

This integration connects Gladys to **Sunricher DALI gateways** (SR-GW-EDA,
configured with the DALI Center app) **locally**, through the MQTT server
built into the gateway: no cloud, no other broker to install.

> **Never tested with a real gateway.** The protocol comes from the
> PySrDaliGateway library (Sunricher, Apache-2.0), used by Home Assistant.
> Unofficial, not affiliated with Sunricher.

## What the integration does

At every connection, and when you click "Scan" (once a minute at most), it
reads the list the gateway already keeps (it never starts a search on the
DALI bus):

- **DALI lights**: on/off, brightness, and by DALI type the colour temperature
  (DT8 Tc) or the colour (DT8 RGB, XY, RGBW, RGBWA).
- **DALI groups**: on/off and brightness of the group. The gateway gives no
  state of the group itself: Gladys shows "on" when a member is on, "off" when
  all are off (unknown while a member is unknown).
- **Scenes**: an "Activate the scene" button per scene of the gateway. Scenes
  are created and edited in DALI Center.
- **Motion sensors**: motion (instant) and occupancy (stays on until "vacant").
- **Light sensors**: lux (0 to 1000; a value outside is ignored).
- **DALI-2 push button panels**: no device, but a **scene trigger** "DALI
  push button panel" (panel, key number, event: pressed, held, double pressed,
  turned, released).

States come in real time (the gateway pushes them). Not supported yet: the
energy use of the lights, identify (blinking), sensor and driver settings.

## 1. Pairing: getting the credentials of the gateway

The gateway gives its MQTT **user name** and **password** only after its
button is pressed, as an answer to a request sent on the local network by UDP
multicast. The container of a Gladys integration does not see the multicast of
your network (Docker bridge): pairing is therefore done **once**, by a small
command on the Gladys machine (or any computer of the same network with
Node.js 22 or later):

```bash
docker run --rm -it --network host ghcr.io/lm1lc3n7/gladys-sunricher-dali:<version> node scripts/pair.mjs
```

(replace `<version>` with the installed version shown in Gladys; from a clone
of the repository: `node scripts/pair.mjs`).

1. Run the command: it looks for gateways for 3 minutes.
2. Press the **Reset** button of the gateway **once, briefly**.
3. The command shows the **address**, the **MQTT port**, the **serial
   number**, the **user name**, the **password** and whether the gateway uses
   **TLS**.
4. Copy these values into the configuration of the integration, then clear
   the terminal: the password is shown there only (never written to a file or
   a log).

Options: `--serial <number>` (only that gateway), `--timeout <seconds>`. When
several gateways answer, the first one with credentials is shown: run again
with `--serial` for the others.

The request and the answer are scrambled with a fixed key published in
PySrDaliGateway: a convention of the gateway protocol, not a protection. The
`type: "HA"` field of the request is the one the manufacturer's library uses
for third-party home automation systems.

## 2. Configuration

- **Address of the gateway**: its IP address (give it a fixed address in your
  router).
- **MQTT port**: the one shown by the pairing (1883 by default).
- **Serial number**: as shown (on the SR-GW-EDA, the MAC address in capitals
  without separators; `A1:B2:…` is accepted). It is part of the MQTT topics:
  the integration only takes the messages of **this** serial number, and
  ignores a message that names another one.
- **User name** and **password**: those of the pairing. The password is kept
  by Gladys in its database, never shown again, sent only to the gateway,
  never written in the logs.
- **TLS**: only when the pairing says `TLS: yes`.
- **Certificate fingerprint** (TLS only, optional): empty, the first
  certificate seen is pinned and kept in `/data` **before** the password is
  sent.
- **Language of the names**: for the devices without a name in the gateway.

The **Test the connection** button tries a connection (when none is under way)
and shows what was read.

## Security and limits

- **Without TLS** (how the gateway works by default), the user name and the
  password travel **in clear** on your local network: the status of the
  integration says so. With TLS, the certificate is pinned; if it changes,
  **nothing is sent**, the connection stops with no new try and the status
  shows both fingerprints. If you replaced or reset the gateway, enter the new
  fingerprint. Emptying the field never relearns a certificate.
- **Refused credentials** (answer 4 or 5 of the gateway, or two connections in
  a row closed right after the credentials were sent): a stop kept in
  `/data`, **no new try**, even after a restart. It is lifted by changing the
  configuration (new credentials after a new pairing), or by "Test the
  connection" once a connection works.
- **One MQTT session** at a time; reconnections spaced 10 s, 30 s, 1 min,
  2 min then 5 min; a container that restarts again and again connects at
  most once per 10 s (time of the attempt kept in `/data`).
- **Bounded messages**: 512 KB at most per message, bounded lists and names,
  1,000 messages per 10 s at most; a malformed message or one of another
  serial number is ignored.
- **Many lights**: commands of the same kind sent within 100 ms leave in a
  single MQTT message (32 devices per message); Gladys gets at most 240 states
  per minute, lights and motion sensors first; an unchanged value is sent
  again only every 30 minutes.

## Commands

A command is **acknowledged once written to the gateway**; the light (or the
members of the group, or the lights of the bus after a scene) is read back
1.5 s later and Gladys gets the real state. A command is **refused, nothing
sent**, exactly in these cases:

- the integration is not connected to the gateway, or the connection ended
  before the message was written;
- the command could not leave within 3.5 s;
- the device is not (or no longer) in the list read from the gateway, or
  belongs to another gateway;
- the value is not understood (on/off other than 0 or 1, brightness outside 0
  to 100, temperature outside 153 to 500 mired, colour outside 0 to 16777215,
  scene other than 1, empty value);
- the feature is read only (sensors).

A brightness above 0 also turns the light on; 0 turns it off.

## External ids

Frozen rule (it fixes the devices, their history and your scenes):
`light:<serial>-<bus>-<address>`, `motion:…`, `illuminance:…`,
`group:<serial>-<bus>-<group>`, `scene:<serial>-<bus>-<scene>`, with the serial
number in lower case, the DALI bus (channel) and the DALI short address.
Changing the DALI address of a driver creates a new device in Gladys.

## Troubleshooting

- **"Connected, but the gateway does not answer on the topics of this serial
  number"**: check the serial number (the one of the pairing).
- **Unreachable**: check the IP address and the port; a host firewall may
  block the traffic from the Docker bridge to the local network.
- **A light is missing**: it must be added to the gateway in DALI Center,
  then "Scan" in the Discovery tab.
