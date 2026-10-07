# Homebridge Electrolux Live

Homebridge plugin for Electrolux and AEG appliances using the Electrolux
Developer API, with real-time livestream/SSE state synchronisation and
defensive command handling.

## Highlights

- Electrolux Developer API livestream/SSE is the primary authoritative state source.
- Cached Get Appliance State is used for startup, periodic resynchronisation and fallback.
- A HomeKit action produces at most one Electrolux command request from the plugin.
- Appliance command requests are not retried merely because Electrolux returns HTTP 500 or times out.
- Refresh-token handling includes bounded retries, backoff, single-flight refresh and persistent token rotation.
- Homebridge 2 and current supported Node.js LTS releases are supported.

## Why this project exists

Homebridge Electrolux Live is derived from
[`homebridge-electrolux-devices`](https://github.com/tomekkleszcz/homebridge-electrolux-devices)
by Tomek Kleszcz.

During investigation of an AEG Comfort 6000 air conditioner, Electrolux
confirmed that the command API can time out after a command has already reached
the appliance, and that internal service retry behaviour can result in duplicate
physical deliveries. Electrolux also confirmed that Get Appliance State is
cache-backed and recommended the Developer API livestream for timely state
updates.

This project therefore treats the livestream as the primary state source and
does not retry appliance commands on uncertain HTTP 500 responses.

## Installation

The easiest method is through the Homebridge UI:

1. Open **Plugins**.
2. Search for `homebridge-electrolux-live`.
3. Install **Homebridge Electrolux Live**.
4. Open the plugin settings and enter your Electrolux Developer API credentials.

Command-line installation is also supported:

```bash
npm install -g homebridge-electrolux-live
```

## Configuration

The plugin uses the Homebridge Plugin Settings GUI.

Required:

- `apiKey` - Electrolux Developer API key.
- `refreshToken` - Electrolux Developer API refresh token.

Optional:

- `pollingInterval` - fallback/resynchronisation polling interval in seconds. Default: `120`.
- `carbonDioxideSensorAlarmValue` - CO2 alarm threshold. Default: `1000`.
- `vocMolecularWeight` - VOC molecular weight used by inherited air-purifier mappings. Default: `30.026`.

A polling interval below 120 seconds is discouraged because it can increase
Electrolux API rate-limit pressure.

Rotated authentication data is stored inside the Homebridge storage directory
as `homebridge_electrolux_device_persist.json`.

## Supported devices

The inherited device mappings currently include:

- Comfort 600 / Comfort 6000 portable air conditioner;
- Well A5 / AX5 air purifier;
- Well A7 air purifier;
- Pure A9 / AX9 air purifier;
- UltimateHome 500 air purifier.

Unsupported Electrolux appliances can be reported through the
[GitHub issue tracker](https://github.com/ikthezeus/homebridge-electrolux-live/issues).

## State synchronisation

Primary:

- Electrolux Developer API livestream / Server-Sent Events (SSE).

Fallback and resynchronisation:

- Get Appliance State at startup;
- slow fallback polling when the livestream is disconnected;
- periodic resynchronisation while the livestream is healthy, without overwriting
  properties currently supplied by the livestream.

## Command behaviour

The plugin deliberately does not retry appliance commands after an HTTP 500 or
timeout because Electrolux has confirmed that such a response can occur after
the appliance has already executed the command.

Where possible, resulting appliance state is reconciled through the livestream.

## Compatibility

- Homebridge `^1.8.0 || ^2.0.0`
- Node.js `22`, `24` and `26` LTS lines

The project CI validates Node.js 22, 24 and 26.

## Repository model

GitLab is the authoritative development repository.

The public GitHub repository is the release, issue and Homebridge verification
surface:

https://github.com/ikthezeus/homebridge-electrolux-live

## Project origin and licence

The project is derived from `homebridge-electrolux-devices` by Tomek Kleszcz.

The original project and this fork are distributed under the Apache License 2.0.
The upstream source used to create this project is preserved by the
`upstream-v1.1.1-baseline` Git tag.

See [`NOTICE`](NOTICE) and [`LICENSE`](LICENSE).
