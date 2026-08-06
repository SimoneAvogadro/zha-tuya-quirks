/**
 * Energy Stats Panel for Home Assistant
 * An expandable statistics panel for any cumulative energy meter: Day / Week /
 * Month / Year bar charts with a date navigator, in the shape of the official
 * Tuya app's "Electricity Statistics" screen.
 *
 * Not a Lovelace card — a plain custom element (<energy-stats-panel>) driven by
 * a host card through setup(hass, entityId). It knows nothing about its host.
 *
 * All data comes from the recorder's long-term statistics, which Home Assistant
 * keeps forever for sensors with device_class: energy and state_class:
 * total / total_increasing.
 *
 * Pure HTMLElement + Shadow DOM (no LitElement, no build tools).
 */

// ── Pure period arithmetic ──
// Declared as top-level `function` so tests/energy-stats-panel.test.js can reach
// them from a node:vm context. Calendar constructors everywhere, never
// millisecond addition, so DST and month lengths take care of themselves.

function panelPeriodOf(view) {
  if (view === "day") return "hour";
  if (view === "year") return "month";
  return "day";
}

function panelPeriodStart(view, anchorMs) {
  const a = new Date(anchorMs);
  const y = a.getFullYear(), m = a.getMonth(), d = a.getDate();
  if (view === "day") return new Date(y, m, d).getTime();
  if (view === "week") {
    const dow = (new Date(y, m, d).getDay() + 6) % 7; // 0 = Monday
    return new Date(y, m, d - dow).getTime();
  }
  if (view === "month") return new Date(y, m, 1).getTime();
  return new Date(y, 0, 1).getTime();
}

function panelShift(view, periodStartMs, delta) {
  const s = new Date(periodStartMs);
  const y = s.getFullYear(), m = s.getMonth(), d = s.getDate();
  if (view === "day") return new Date(y, m, d + delta).getTime();
  if (view === "week") return new Date(y, m, d + 7 * delta).getTime();
  if (view === "month") return new Date(y, m + delta, 1).getTime();
  return new Date(y + delta, 0, 1).getTime();
}

// One query window covering the previous period and the current one, so the
// "vs previous period" comparison costs no extra round trip.
function panelWindow(view, anchorMs) {
  const start = panelPeriodStart(view, anchorMs);
  return {
    period: panelPeriodOf(view),
    prevStart: panelShift(view, start, -1),
    start,
    end: panelShift(view, start, 1),
  };
}

function panelSlots(view, periodStartMs) {
  const end = panelShift(view, periodStartMs, 1);
  const out = [];
  if (view === "day") {
    // Deliberately millisecond-stepped: a DST day is 23 or 25 hours long and
    // must produce that many bars, matching what the recorder returns.
    for (let t = periodStartMs; t < end; t += 3600000) out.push(t);
    return out;
  }
  const s = new Date(periodStartMs);
  const y = s.getFullYear(), m = s.getMonth(), d = s.getDate();
  if (view === "year") {
    for (let i = 0; i < 12; i++) out.push(new Date(y, m + i, 1).getTime());
    return out;
  }
  for (let i = 0; ; i++) {
    const t = new Date(y, m, d + i).getTime();
    if (t >= end) break;
    out.push(t);
  }
  return out;
}

function panelBucketMs(raw) {
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return null;
  const t = Date.parse(raw);
  return isNaN(t) ? null : t;
}

// Map recorder buckets onto slots. The recorder omits buckets with no data, so
// slots are filled by position — a bucket lands in the last slot starting at or
// before it — and anything outside [slots[0], endMs) is dropped. Without the
// zero-fill the chart shifts every time the socket was offline.
function panelFill(slots, buckets, endMs) {
  const out = new Array(slots.length).fill(0);
  if (!Array.isArray(buckets) || slots.length === 0) return out;
  const limit = typeof endMs === "number" ? endMs : Infinity;
  for (const b of buckets) {
    const t = panelBucketMs(b && b.start);
    if (t === null || t < slots[0] || t >= limit) continue;
    let idx = -1;
    for (let k = 0; k < slots.length; k++) {
      if (slots[k] <= t) idx = k;
      else break;
    }
    if (idx >= 0 && typeof b.change === "number") out[idx] += b.change;
  }
  return out;
}

function panelDelta(cur, prev) {
  if (typeof prev !== "number" || !(prev > 0)) return null;
  if (typeof cur !== "number") return null;
  return ((cur - prev) / prev) * 100;
}

function panelIsCurrent(view, periodStartMs, nowMs) {
  return panelPeriodStart(view, nowMs) === periodStartMs;
}
