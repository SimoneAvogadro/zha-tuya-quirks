# Tuya ZHA

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
| `_TZ3210_ol1uhvza` | `TS130F` | Lonsonho QS-Zigbee-C03 roller-shutter / curtain module. Keeps the upstream position fix and adds the Tuya settings as entities: **Motor reversal** switch (swap up/down), **Calibration mode** switch, **Travel time** number (seconds), plus **Moving state** (Up/Stop/Down) and **Opening** (%) diagnostic sensors. **Fixes the position jumping back to a fixed value when the shutter is idle**: on this firmware `current_position_lift_percentage` is a writable NVRAM register, not a live read-out, so ZHA's 15-minute periodic report (and its read on startup) answer with whatever was last written to it. The quirk ignores position updates that arrive while the motor is at rest and contradict the known position, and writes the true position back into the device a few seconds after every travel, so reads and reports agree with reality and the position survives a restart. |
| `_TZE200_a7sghmms`, `_TZE204_a7sghmms`, `_TZE200_7ytb3h8u`, `_TZE204_7ytb3h8u`, `_TZE284_7ytb3h8u` | `TS0601` | GiEX QT06 smart irrigation valve. Answers `commandMcuSyncTime` with the 2000-01-01 Tuya epoch (not the upstream 1970), so the firmware stops re-firing `MCU_SYNC` aggressively (which drained the battery in days and made `irrigation_end_time` flap). Also patches `giex_string_to_dt` so start/end times use HA's local timezone (upstream hardcodes +04:00) and tolerate the startup-restored value. **Syncs the MCU clock before every valve open**: the quirk inserts the Tuya time frame (0x24, with its epoch) in front of the on/off DP, waits ~1.5 s, then opens — so `irrigation_start_time` / `irrigation_end_time` are right whatever turned the valve on (card, automation, Assist). ZHA never calls `bind()` on the 0xEF00 cluster, so the open DP is the one hook that provably fires. |
| `HOBEIAN ZG-303Z` | `ZG-303Z` | Excellux 3-in-1 soil sensor. **Swaps the two humidity channels** so the entities match the physical measurement: the radio reports on the standard humidity cluster (0x0405) are diverted to the **soil moisture** entity, and DP 109 feeds the **air humidity** entity. Maps DP 5 → temperature; routes the other periodic DPs (3, 9, 15, 102, 104, 105, 110, 111, 112) to a no-op so ZHA stops replying `UNSUPPORTED_ATTRIBUTE` (which the sleepy device fails to retrieve in time, cascading into `MAC_INDIRECT_TIMEOUT`). |

> **ZG-303Z: this quirk inverts the two humidity channels compared to the Z2M reference converter** ([Koenkk/zigbee2mqtt#30576](https://github.com/Koenkk/zigbee2mqtt/issues/30576)), which maps DP 109 → soil moisture and leaves cluster 0x0405 as air humidity. Ten days of history from two separate units showed the opposite: the 0x0405 value decays slowly and monotonically after watering (99 % → 63 %, no day/night cycle — soil drying out), while DP 109 swings 20-30 points a day, saturates at 99 % every night and bottoms out at 13-14h in anticorrelation with temperature (ambient air). Either the Z2M converter targets a different firmware or it was never validated in the field. If *your* unit shows a `_soil_moisture` entity with a strong diurnal cycle and a `_humidity` entity that barely moves, you have the other behaviour — please open an issue with the two histories. Upgrading from the previous mapping: the entity ids don't change, but their meaning does, so check any automation or card threshold built on `_soil_moisture` / `_humidity`.

> **TS130F travel time:** the device *measures* it in tenths of a second — its own auto-calibration lands on values like 23.9 s, and those are shown as they are — but it only **applies whole seconds when the value is written**. Captured on the wire: writing `0xF003 = 239` (23.9 s) is acknowledged with `SUCCESS` and immediately followed by a report of `230`, i.e. 23.0 s; 24.3 s becomes 24.0 s, 26.4 s becomes 26.0 s, while a whole second is kept as written. The firmware truncates, so the quirk rounds a written value to the **nearest** second instead: asking for 23.9 s from a script gives 24.0 s rather than 23.0 s. An exact 23.9 s can only be obtained by re-running the device's auto-calibration, not by writing it.

> **TS130F idle position:** the bad value is whatever was last written into the device's position register — often the position it held when it was migrated off the Tuya cloud — which is why recalibrating never helps and every unit gets a different constant. It is a firmware trait of the whole TS130F family, reported upstream in [home-assistant/core#142224](https://github.com/home-assistant/core/issues/142224) and still unfixed; there is no OTA image for `_TZ3210_ol1uhvza`. Zigbee2MQTT avoids the 15-minute half of it by never configuring reporting on cluster 0x0102 for this model, and applies the same write-back remedy on a sibling firmware. After installing this version the position is corrected by the first travel you make; the guard then keeps it.

> The GiEX and ZG-303Z quirks used to ship inside the [tuya-cards-for-ha](https://github.com/SimoneAvogadro/tuya-cards-for-ha) integration. They moved here unchanged (same clusters, same entity ids — nothing to rename), so that everything ZHA-specific lives in one place. **Update this repo first, then tuya-cards-for-ha**: during the overlap both register the same quirk, which is harmless; the reverse order leaves the devices on the upstream quirk for one restart.

## Services

Besides the quirks, the integration registers one radio-level helper service. It exists because some Tuya devices need help that only a real Zigbee frame can give, and the platform-agnostic irrigation integration in [tuya-cards-for-ha](https://github.com/SimoneAvogadro/tuya-cards-for-ha) calls it instead of importing ZHA internals. It takes `entity_id`: any entity of the target ZHA device (the valve switch, typically), and raises a normal service error if the entity is not a ZHA device. (The GiEX clock sync is deliberately *not* a service: the quirk does it on every open, see the table above.)

| Service | What it does |
|---|---|
| `zha_tuya_quirks.keepalive_poll` | Performs a genuine over-the-air read of the device's Basic cluster (`app_version`, cache bypassed). Any reply, even an unsupported-attribute status, refreshes ZHA's *last seen*, so a sleepy battery device on a weak link is not marked `unavailable` after `consider_unavailable_battery` (6 h). An entity-level `homeassistant.update_entity` would not do this: the Tuya quirks answer the On/Off cluster from a local cache without touching the radio. The irrigation integration calls it hourly for idle battery valves. |

## Lovelace cards

Besides the quirks, the integration ships a small bundle of **generic Lovelace
cards** and auto-registers it as a dashboard resource (storage-mode dashboards
only; YAML-mode users add `/zha_tuya_quirks/zha-tuya-cards.js` manually). The
card sources live in `src/` and are concatenated into
`custom_components/zha_tuya_quirks/www/zha-tuya-cards.js` by `build.sh`.

| Card | Purpose |
|---|---|
| `power-switch-card` | A compact tile for any on/off **switch that also has a power sensor** on the same device. Shows the toggle + name + `state · instantaneous power`. When the card is wide enough it also shows **today's energy** on the right — computed automatically as `meter_now − meter_at_midnight` from the device's cumulative energy meter (no `utility_meter`/helper needed). Devices without an energy meter simply omit the daily figure. |

### `power-switch-card` usage

Add it from the dashboard card picker — search **"Power Switch Card"** (or, in
Italian, *"Presa con consumi"*) — and pick the socket. The power and energy
sensors are discovered automatically from the switch's **device** (by
`device_class`, not by entity-name suffix), and the editor lists only switches
whose device has a power sensor (child-lock and other config switches are
hidden).

The card is **responsive to its own width**:

- **Narrow** (e.g. half a column): toggle + name + `state · instantaneous power`.
- **Wide** (full width): additionally shows **today's energy** on the right.

Today's energy is derived from the device's cumulative meter via Home
Assistant's long-term statistics (`meter_now − meter_at_local_midnight`), so it
needs no `utility_meter`/helper and updates live. A device without an energy
meter just omits the daily figure.

Minimal config (the visual editor writes this for you):

```yaml
type: custom:power-switch-card
switch: switch.presa_contatore_cantina
# Optional overrides — normally auto-discovered from the device:
# name: Presa cantina
# power: sensor.presa_contatore_cantina_power
# energy: sensor.presa_contatore_cantina_summation_delivered   # "" to hide daily
```

Tap the icon to toggle the switch; tap the row to open the more-info dialog.

#### Energy statistics

When the device has a cumulative energy meter, a **⊕** button appears at the
right of the tile — on narrow cards too, where the daily figure itself is
hidden. It expands an inline panel with **Day / Week / Month / Year** tabs, a
bar chart, the period total and a comparison against the previous period, plus
**◀ ▶** to step through past periods. Tap a bar to read its exact value.

Everything comes from Home Assistant's own long-term statistics — no
`utility_meter` or helper — so two things follow: the history starts when the
sensor was created in Home Assistant (not when the device was manufactured),
and the figures will not match the Tuya app to the decimal, since Home
Assistant integrates the readings it receives over Zigbee while Tuya reads the
chip's internal counter.

## Installation

### Via HACS (recommended)

1. In HACS, add this repository as a **custom repository** (category:
   *Integration*).
2. Install **Tuya ZHA**.
3. Restart Home Assistant.
4. Go to **Settings → Devices & Services → Add Integration**, search for
   **Tuya ZHA**, and click through (there is nothing to configure).

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
4. If the quirk does more than declare clusters and attributes — anything with
   state, timing or a value conversion — add a test for that logic under
   `tests/` (see *Development* below).

## Development

There is no linter, no CI and no test runner. The two tests are plain scripts:

| Test | Run it with | Covers |
|---|---|---|
| `tests/energy-stats-panel.test.js` | `TZ=Europe/Rome node tests/energy-stats-panel.test.js` | The period helpers of the shared `<energy-stats-panel>` element, via `node:vm`. |
| `tests/ts130f_quirk_test.py` | `python3 tests/ts130f_quirk_test.py` | The TS130F stale-position guard, its write-back, and the travel-time rounding. |

The Python test stubs the handful of `zigpy` / `zhaquirks` names the quirk
imports, so it needs nothing installed and runs anywhere. Keep those stubs
faithful to the real library: an earlier version of them called
`_update_attribute` on writes, which real zigpy does not, and that hid a bug
that only showed up on the device.

The Lovelace bundle is built with `bash build.sh`, which concatenates `src/*.js`
into `zha-tuya-cards.js`. Never hand-edit the bundle. Bump `VERSION` in
`custom_components/zha_tuya_quirks/const.py` and `version` in `manifest.json`
together: the same value cache-busts the card bundle.

Everything else is validated by loading the integration in a running Home
Assistant instance, then reconfiguring or re-pairing the device.

## License

[MIT](LICENSE) © Simone Avogadro
