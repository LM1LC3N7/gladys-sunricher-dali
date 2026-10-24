# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the project below. The ported code
was rewritten, not copied; the changes are described below.

## PySrDaliGateway

<https://github.com/maginawin/PySrDaliGateway> (package `PySrDaliGateway`,
version 0.21.0, commit `a93d69d`, 2026-05-13), by Sunricher, the library of
the Home Assistant "Sunricher DALI" integration. Licensed under the **Apache
License 2.0**, whose full text is this integration's own `LICENSE`. Its
`LICENSE` file carries this notice:

```
Copyright 2025 Sunricher

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

PySrDaliGateway has no `NOTICE` file.

Ported:

- `gateway.py`, in `src/dali/protocol.js`, `src/app.js` and
  `src/mqtt/client.js`: the MQTT connection to the gateway with the
  credentials of the pairing, the topics `/<serial>/client/reciver/` and
  `/<serial>/server/publish/`, the message envelope (`cmd`, `msgId`, `gwSn`),
  the commands `getVersion`, `searchDev` (`searchFlag: "exited"`),
  `getGroup`, `readGroup`, `getScene`, `writeDev`, `readDev`, `writeGroup`,
  `writeScene`, their answers and the pushes `devStatus` and
  `onlineStatus`, the batching of `writeDev` / `readDev` within 100 ms with
  the properties merged by data point, and at most 3 group reads at a time.
- `const.py`, `helper.py`, in `src/constants.js` and `src/dali/protocol.js`:
  the data points (power 20, white 21, brightness 22 on 0-1000, colour
  temperature 23 in kelvin, HSV colour 24), the DALI device types and colour
  modes, the motion states, the illuminance data point and its valid range,
  the panel key events.
- `device.py`, `group.py`, `scene.py`, `base.py`, in `src/app.js` and
  `src/dali/protocol.js`: the property format (`dpid`, `dataType`, `value`),
  power on with a brightness, the HSV text of a colour.
- `certs/ca.crt`, copied unchanged as `src/certs/sunricher-root-ca.pem`
  (Sunricher root certificate, "O=SR, CN=Root CA", valid until 2035), and
  the way `_setup_ssl_sync` uses it (chain required, host name not checked),
  in `src/mqtt/client.js`.
- `udp_client.py`, `discovery.py`, in `scripts/pair.mjs`: the pairing request
  (AES-128-CTR under the protocol key and initial vector published there, a
  random key, `type: "HA"`), multicast 239.255.255.250 port 1900, answers on
  port 50569, the credentials in the answer.

Changed from PySrDaliGateway:

- An MQTT 3.1.1 client of our own instead of paho-mqtt: one session, the
  exact topic only, every packet bounded; the TLS certificate checked against
  the Sunricher root on the first contact, then pinned (SHA-256), always
  before the CONNECT that carries the password.
- Refused credentials stop the connection for good (no reconnection loop);
  reconnections spaced from 10 s to 5 min.
- Every message validated strictly (strict integers in DALI ranges, the
  configured serial number, bounded lists and names); an unknown motion data
  point is dropped rather than read as "no motion".
- The brightness written as an integer 0-1000; the colour sent with its value
  at full (the brightness is a feature of its own in Gladys).
- No bus scan, no energy, no device or sensor parameters, no identify, no
  gateway restart.
- The pairing helper is a command run once on the host network, not part of
  the integration.
