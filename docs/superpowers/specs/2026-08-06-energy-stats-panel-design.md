# Energy stats panel for `power-switch-card`

**Date:** 2026-08-06
**Status:** approved, ready for implementation planning

## Goal

Extend `power-switch-card` with an expandable statistics panel, reachable from a `⊕`
button next to the daily-energy figure. The panel reproduces the *Electricity
Statistics* screen of the official Tuya app: tabbed Day / Week / Month / Year views, a
bar chart, a period total, and a date navigator — so the user can answer "how much did
this socket consume yesterday / last month?" without leaving the dashboard.

## Why it is feasible without new backend code

Every view is a different `period` argument to `recorder/statistics_during_period`, the
same WebSocket call the card already makes for today's energy
(`src/power-switch-card.js:298`). No Python change, no new integration, no dependency.

Long-term statistics are generated for any sensor with `device_class: energy` and
`state_class: total` / `total_increasing`, and are **never purged** (unlike raw states,
kept 10 days by default). Both ZHA sockets on the target instance qualify:

- `sensor.presa_contatore_cantina_summation_delivered` — `total_increasing`, kWh
- `sensor.sottotetto_presa_sottotetto_summation_delivered` — `total_increasing`, kWh

Target instance: Home Assistant 2026.8.0, timezone `Europe/Rome`, `recorder` and
`energy` loaded.

## User interface

The existing tile row is unchanged. A `⊕` / `⊖` toggle is appended to it, **always
visible** whenever the switch's device has an energy meter — including on narrow cards
(<360px) where the daily figure itself is hidden by the container query at
`src/power-switch-card.js:372`. Devices with no energy meter get no button and no
panel; the card stays exactly as it is today.

Expanding grows the card in place (inline expansion, not a dialog) — no dependency on
Home Assistant's internal `<ha-dialog>`.

```
┌────────────────────────────────────────┐
│ (⏻) Presa cantina          1,24        │
│      Acceso · 137 W        OGGI      ⊖ │
├────────────────────────────────────────┤
│  [Giorno] Settimana  Mese  Anno        │
│                                        │
│  7,46 kWh                  ▲ +12% ieri │
│                                        │
│  ▁▃▅▂▇▄▁▃▅▂▇█▁▃▅▂▇▄▁▃▅▂▇▄              │
│  00      06      12      18            │
│                                        │
│       ◀     6 ago 2026      ▶          │
└────────────────────────────────────────┘
```

### Behaviour

- **Tabs** — segmented control, four views. The panel always opens on *Day*; the chosen
  tab is deliberately **not** persisted.
- **Bars** — the bucket covering "now" is rendered in the full accent colour, the others
  muted, matching the Tuya app. Tapping a bar replaces the total line with
  `14:00 · 0,42 kWh`; tapping it again deselects.
- **Navigator** — `▶` is disabled on the current period. `◀` is unbounded; periods with
  no recorded data render an empty chart with a "no data" label.
- **Comparison** — `▲ +12% vs ieri` / `vs settimana scorsa` / `vs mese scorso` /
  `vs anno scorso`, shown to the right of the total. Hidden when the previous period is
  zero or has no data, so the first day never shows `+∞%`.
- **Expanded state is per page load** — the panel always starts collapsed. No `expanded`
  config key.

### Chart rendering

Bars are `<div>` elements in a flexbox with `height: N%`, **not** SVG. Rationale:
responsive for free, `border-radius` that does not distort under non-uniform scaling,
native touch targets for the tap-to-inspect interaction, and roughly 70 fewer lines than
an equivalent `viewBox`-based SVG implementation.

## Data layer

A single `_fetchStats(view, anchorDate)` performs **one WebSocket call per view change**:

```js
hass.callWS({
  type: "recorder/statistics_during_period",
  start_time, end_time,
  statistic_ids: [energyId],
  period,                      // "hour" | "day" | "month"
  types: ["change"],
  units: { energy: "kWh" },
})
```

| View | `period` | Requested window | Slots returned → split |
|---|---|---|---|
| Day | `hour` | midnight of the *previous* day → next midnight | 48 → 24 prev + 24 current |
| Week | `day` | Monday of the *previous* week → Sunday+1 | 14 → 7 + 7 |
| Month | `day` | 1st of the *previous* month → 1st of the next | ~60 → prev + current |
| Year | `month` | Jan 1 of the *previous* year → Jan 1 of the next | 24 → 12 + 12 |

Requesting two periods in one query and splitting the array in half makes the
"vs previous period" comparison free — no extra round trip.

### Correctness details

- **Missing buckets must be zero-filled.** The API returns only buckets that exist. Slots
  are built by index, mapping each `bucket.start` onto its local calendar slot — never by
  assuming the returned array is dense. Without this the chart shifts every time the
  socket was offline. `start` is epoch milliseconds on current Home Assistant; the parser
  should also accept an ISO string, which older cores returned.
- **Timezone**: window boundaries are built with `new Date(y, m, d)` (browser-local
  midnight); Home Assistant aggregates `day` / `month` buckets in its own configured
  timezone. These agree when browser and instance share a timezone. A browser on a
  different timezone will see the monthly view shifted by a day — accepted, not
  compensated.
- **Units** are forced to `kWh` via the `units` argument so a sensor reporting Wh does not
  blow up the scale.
- **Cache**: a `Map` keyed by `view|startISO`. The entry covering the current period is
  refreshed on the existing 15-minute timer (`src/power-switch-card.js:274`); past
  periods are cached indefinitely for the page's lifetime.
- The *Day / today* total is the same sum of `change` values that feeds the "OGGI" figure
  in the header, so the two numbers always agree.

## Code structure

The panel does **not** go inside `power-switch-card.js`; that would push the file to
~900 lines and mix the tile with the chart.

- **New `src/energy-stats-panel.js`** — a custom element `<energy-stats-panel>` with a
  single public interface: `setup(hass, energyEntityId)` plus a `hass` setter. It knows
  nothing about the card, is not a Lovelace card (no `window.customCards.push`), and is
  reusable by future cards.
- **`src/power-switch-card.js`** grows by roughly 60 lines: the `⊕` button, open/closed
  state, and `document.createElement("energy-stats-panel")` in its shadow DOM.

Ordering is not a concern: `build.sh` concatenates `src/*.js` into a single module, and
`power-switch-card.js` only references `<energy-stats-panel>` at runtime
(`document.createElement`), never at module-evaluation time.

### Ripple effects

- `src/` will contain its first file that is **not** a card. The *Lovelace cards* section
  of both `CLAUDE.md` and `README.md` must say so, or a future session will treat it as
  one.
- `VERSION` must be bumped to `1.2.0` in **both** `custom_components/zha_tuya_quirks/const.py`
  and `custom_components/zha_tuya_quirks/manifest.json` (they must stay in sync) so the
  `?v=` query string busts the browser cache for the rebuilt bundle.
- `README.md` gets a short subsection describing the panel under `power-switch-card` usage.

### Internationalisation

The panel ships its own `I18N` block in it / en / zh, matching the existing card
convention (`src/power-switch-card.js:20`). New strings: the four tab labels, `no data`,
the four `vs <previous period>` phrases, and the units/percent formatting. Month and
weekday names come from `Intl.DateTimeFormat(hass.language)` rather than hardcoded lists.

## Out of scope

Stated explicitly so the first run holds no surprises:

1. **History starts when the sensor was created in Home Assistant.** The Tuya app screens
   show bars back to January and `Total Ele 4200,24 kWh`; that data lives in the Tuya
   cloud and is not recoverable. The Year view will be partial until HA accumulates.
2. **Values will not match the Tuya app to the decimal.** Home Assistant integrates the
   readings it receives over Zigbee; Tuya reads the chip's internal counter.
3. **No cumulative "Total Ele" view, and no voltage / current / temperature** readouts
   from the Tuya app's main screen.

## Verification

There is no test suite in this repo; validation is by loading the integration in the
running Home Assistant instance (see `CLAUDE.md`). Acceptance checks:

1. `bash build.sh` regenerates the bundle and copies it into `www/`.
2. On a socket with an energy meter, `⊕` expands the panel; on a socket without one, no
   button appears and the tile is byte-identical in behaviour to today.
3. The *Day / today* total equals the "OGGI" figure in the header.
4. Switching to *Month* and stepping back with `◀` shows last month's daily bars.
5. `▶` is disabled on the current period.
6. A period with no recorded data renders the empty state, not a broken chart.
7. Panel is verified at both narrow (<360px) and wide card widths.
