# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Home Assistant custom integration, distributed via HACS, whose sole purpose is to
bundle and auto-register custom **ZHA quirks** for Tuya Zigbee devices. A quirk teaches
ZHA how to talk to a device whose firmware deviates from the Zigbee spec (remapping
clusters, exposing hidden settings, fixing data conversions).

The integration also serves a small bundle of **generic Lovelace cards** (see *Lovelace
cards* below) — the only build step in the repo (`bash build.sh`) concatenates the card
sources. There is no test suite or linter. Validation happens by loading the integration
in a running Home Assistant instance. A HomeAssistant Proxy MCP server is available in
this session (`ha_*` / `hass_*` tools) — use it to inspect device state, restart HA, read
core logs, and verify a quirk or card applied.

## Architecture

The integration is a thin shell; the value is in the quirks.

- `custom_components/zha_tuya_quirks/__init__.py` — `async_setup_entry` does almost
  nothing. The real work is the module-level `from . import quirks`, which runs at HA
  import time (before ZHA enumerates devices). **Quirk registration is an import
  side-effect**, not something done in `async_setup_entry`.
- `quirks/__init__.py` — imports each quirk module for its side-effect. **Every new
  quirk file must be added here** or it never registers.
- `quirks/<device-family>.py` — one quirk per file. Each registers itself into zigpy's
  global registry simply by being imported: either a `CustomDevice` subclass definition,
  or a `QuirkBuilder(...).add_to_registry()` call (QuirksV2 style — see
  `tuya_ts0001_fdxihpp7.py`).
- `config_flow.py` — singleton, zero-input flow. Exists only so the integration can be
  enabled from the UI; aborts as `already_configured` on repeat.

### Critical constraints

- **Quirk modules must be self-contained.** They must not import from
  `custom_components.zha_tuya_quirks.*` except `quirks.*`. This keeps each quirk working
  even when ZHA loads it directly via `zha.custom_quirks_path` instead of through this
  integration. Quirks may import from `zigpy` and `zhaquirks` (ZHA's quirk library).
- **Registration cannot be undone.** zigpy's registry has no public de-registration API.
  `async_unload_entry` is a no-op; removing/changing a quirk requires an HA restart.
- **Override semantics: last-registered-wins** for the same `(manufacturer, model)`
  pair. A quirk in the user's own `zha.custom_quirks_path` shadows the bundled one — this
  is intentional and lets users patch locally without forking.

## Adding a new quirk

1. Create `custom_components/zha_tuya_quirks/quirks/<device-family>.py`, self-contained
   (see constraints above).
2. Add a side-effect import line in `quirks/__init__.py`.
3. Add a row to the **Supported devices** table in `README.md`.

## Lovelace cards

Beyond the quirks, `async_setup_entry` calls `_async_register_frontend`, which serves
`custom_components/zha_tuya_quirks/www/` as the static path `/zha_tuya_quirks` and (once
Lovelace is set up, via `async_when_setup`) auto-registers each module in `JSMODULES`
(`const.py`) as a storage-mode dashboard resource at `/zha_tuya_quirks/<file>?v=<VERSION>`.
This mirrors the proven implementation in the sibling `tuya-cards-for-ha` repo.

- **Sources** live in `src/*.js`; `bash build.sh` concatenates them (header + each file)
  into `zha-tuya-cards.js` and copies it into `.../www/`. **Never hand-edit the bundle.**
- **Cards are pure `HTMLElement` + Shadow DOM** (no LitElement, no npm). Each is
  self-contained, ships an i18n block (it/en/zh via `hass.language` / the picker reads
  `localStorage.selectedLanguage`), a visual editor (`getConfigElement`) with
  auto-discovery, and ends with `customElements.define(...)` + `window.customCards.push(...)`.
- **`power-switch-card`** resolves its power/energy sensors from the switch's *device*
  (registry: `hass.entities[id].device_id` → sibling sensors by `device_class`), not by
  name suffix, and computes "today's energy" from the cumulative meter via
  `recorder/statistics_during_period` (baseline at local midnight, re-synced every 15 min).

### Adding a new card

1. Create `src/<card-name>.js`, self-contained (define + `window.customCards.push`).
2. Run `bash build.sh`.
3. Add a row to the **Lovelace cards** table in `README.md`.
4. Bump `VERSION` (see *Versioning*) so the `?v=` cache-bust forces browsers to refetch.

## Versioning

Version is duplicated in `manifest.json` (`version`) and `const.py` (`VERSION`) — keep
them in sync; the same `VERSION` cache-busts the Lovelace bundle (`JSMODULES`). Bump it
when changing card sources. `manifest.json` declares
`"dependencies": ["zha", "frontend", "http", "lovelace"]` (the last three back the card
serving / Lovelace resource registration).

## User-facing strings

UI text for selects/entities lives in `strings.json` and `translations/{en,it}.json`,
keyed by the `translation_key` set in the quirk (e.g. `external_switch_type`). The repo
ships English and Italian translations.

## Applying a quirk to an already-paired device

Quirks match on device join. For an already-paired device: ensure the integration is
installed and HA has been restarted (so the quirk registers before ZHA enumerates
devices), then use **Reconfigure device** in ZHA or re-pair.
