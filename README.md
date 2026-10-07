# Homebridge Electrolux Live

Homebridge plugin for Electrolux and AEG appliances using the Electrolux
Developer API, with a focus on real-time livestream/SSE state synchronisation
and robust command handling.

> **Development status**
>
> Homebridge Electrolux Live is currently under active development and has not
> yet reached its first production release.

## Project origin

Homebridge Electrolux Live is derived from
[`homebridge-electrolux-devices`](https://github.com/tomekkleszcz/homebridge-electrolux-devices)
by Tomek Kleszcz.

The original project is licensed under the Apache License 2.0. The upstream
source used to create this project is preserved by the
`upstream-v1.1.1-baseline` Git tag.

See [`NOTICE`](NOTICE) and [`LICENSE`](LICENSE) for details.

## Why this project exists

The original plugin uses the Electrolux Developer API successfully for device
discovery and control, but primarily relies on the cached Get Appliance State
API for state synchronisation.

During investigation of an AEG Comfort 6000 air conditioner, Electrolux
confirmed that:

- a command can successfully reach an appliance while the command API later
  returns HTTP 500;
- internal timeout/retry behaviour can cause the same command to be delivered
  to the appliance two or three times;
- Get Appliance State is cache-backed and is not intended for high-frequency
  state tracking;
- the Developer API livestream should be used for timely appliance state
  updates.

Homebridge Electrolux Live is being developed around that architecture.

## Planned architecture

### Appliance state

Primary:

- Electrolux Developer API livestream / Server-Sent Events (SSE).

Fallback:

- Get Appliance State during startup;
- resynchronisation after a livestream reconnect;
- optional low-frequency safety polling.

### Commands

Each HomeKit action will result in at most one command request from the plugin.

The plugin will not retry appliance commands merely because Electrolux returns
a timeout or HTTP 500. Where possible, the resulting appliance state will be
confirmed through the livestream.

### Command reconciliation

The design will distinguish between:

- command accepted and confirmed;
- command result uncertain while awaiting livestream state;
- genuine command failure.

This is necessary because the Electrolux command API can currently report an
error after the appliance has already executed the command.

## Supported upstream devices

The inherited upstream implementation currently includes support for:

- Comfort 600 air conditioner;
- Well A5 / AX5 air purifier;
- Well A7 air purifier;
- Pure A9 / AX9 air purifier;
- UltimateHome 500 air purifier.

Existing mappings will be retained while the state and command architecture is
modernised.

## Installation

Do not install this development version on a production Homebridge instance yet.

Installation and migration instructions will be added before the first release.

## Repository model

GitLab is the authoritative development repository.

A public GitHub mirror will also be maintained for visibility, collaboration
and release integration.

## Licence

Apache License 2.0.

See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
