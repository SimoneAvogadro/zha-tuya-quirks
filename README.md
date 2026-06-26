# ZHA Tuya Quirks

Custom [ZHA](https://www.home-assistant.io/integrations/zha/) quirks for Tuya
Zigbee devices, packaged as a one-click Home Assistant integration and
distributed through [HACS](https://hacs.xyz/).

A "quirk" teaches ZHA how to talk to a device whose firmware deviates from the
Zigbee spec — remapping clusters, exposing hidden settings, or fixing wrong
data conversions. This repository bundles such quirks and registers them
automatically, so you don't have to manage `zha.custom_quirks_path` by hand.

## How it works

The quirks live under `custom_components/zha_tuya_quirks/quirks/`. When the
integration is loaded, its `__init__.py` imports that package; each quirk
module registers itself into **zigpy's global registry** as an import
side-effect (a `CustomDevice` subclass definition or a
`QuirkBuilder(...).add_to_registry()` call). ZHA then applies the matching
quirk when it joins or interrogates a device.

This is the same registration that happens when you drop a `.py` file into the
folder configured by `zha.custom_quirks_path` — the integration just automates
it and makes it installable/updatable through HACS.

> **Override semantics:** zigpy uses *last-registered-wins* for the same
> `(manufacturer, model)` pair. A quirk you place in your own
> `zha.custom_quirks_path` will shadow the one bundled here, which is
> intentional — you can patch locally without forking this repo.

## Supported devices

| Manufacturer(s) | Model | What the quirk does |
|---|---|---|
| `_TZ3000_fdxihpp7`, `_TZ3000_mkhkxx1p` | `TS0001` | 1-gang Tuya switch/relay. Exposes the **External switch type** setting (Toggle / State / Momentary) as a `select` entity, so you can configure how a physical wall switch wired to the device behaves. |

## Lovelace cards

Besides the quirks, the integration ships a small bundle of **generic Lovelace
cards** and auto-registers it as a dashboard resource (storage-mode dashboards
only; YAML-mode users add `/zha_tuya_quirks/zha-tuya-cards.js` manually). The
card sources live in `src/` and are concatenated into
`custom_components/zha_tuya_quirks/www/zha-tuya-cards.js` by `build.sh`.

| Card | Purpose |
|---|---|
| `power-switch-card` | A compact tile for any on/off **switch that also has a power sensor** on the same device. Shows the toggle + name + `state · instantaneous power`. When the card is wide enough it also shows **today's energy** on the right — computed automatically as `meter_now − meter_at_midnight` from the device's cumulative energy meter (no `utility_meter`/helper needed). Devices without an energy meter simply omit the daily figure. |

Add it from the dashboard card picker ("Power Switch Card") and pick the socket;
power and energy sensors are discovered from the switch's device.

## Installation

### Via HACS (recommended)

1. In HACS, add this repository as a **custom repository** (category:
   *Integration*).
2. Install **ZHA Tuya Quirks**.
3. Restart Home Assistant.
4. Go to **Settings → Devices & Services → Add Integration**, search for
   **ZHA Tuya Quirks**, and click through (there is nothing to configure).

### Manual

1. Copy `custom_components/zha_tuya_quirks/` into your Home Assistant
   `config/custom_components/` directory.
2. Restart Home Assistant.
3. Add the integration from **Settings → Devices & Services** as above.

## Applying a quirk to an already-paired device

Quirks are matched when a device joins. For a device that is already paired:

1. Make sure the integration is installed and Home Assistant has been
   restarted (so the quirk is registered before ZHA enumerates devices).
2. On the device page in ZHA, use **Reconfigure device** (re-interrogate), or
   re-pair the device if needed.

If you previously placed a copy of one of these quirks in your own
`zha.custom_quirks_path`, remove it after installing this integration so the
two don't diverge over time.

## Adding a new quirk

1. Create `custom_components/zha_tuya_quirks/quirks/<device-family>.py` —
   one quirk per file, self-contained (it must not import from
   `custom_components.zha_tuya_quirks.*` other than `quirks.*`).
2. Add a side-effect import line for it in
   `custom_components/zha_tuya_quirks/quirks/__init__.py`.
3. Add a row to the **Supported devices** table above.

## License

[MIT](LICENSE) © Simone Avogadro
