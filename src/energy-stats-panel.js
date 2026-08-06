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

// ── Labels ──
// Month and weekday names come from Intl, never from hardcoded lists.

function panelSlotLabel(view, slotMs, lang) {
  const d = new Date(slotMs);
  if (view === "day") return String(d.getHours()).padStart(2, "0") + ":00";
  if (view === "year") {
    return new Intl.DateTimeFormat(lang, { month: "long", year: "numeric" }).format(d);
  }
  return new Intl.DateTimeFormat(lang, { weekday: "short", day: "numeric", month: "short" }).format(d);
}

function panelPeriodLabel(view, periodStartMs, lang) {
  const d = new Date(periodStartMs);
  if (view === "day") {
    return new Intl.DateTimeFormat(lang, { day: "numeric", month: "short", year: "numeric" }).format(d);
  }
  if (view === "month") {
    return new Intl.DateTimeFormat(lang, { month: "long", year: "numeric" }).format(d);
  }
  if (view === "year") return String(d.getFullYear());
  const last = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 6);
  const f = new Intl.DateTimeFormat(lang, { day: "numeric", month: "short" });
  return `${f.format(d)} – ${f.format(last)} ${last.getFullYear()}`;
}

function panelAxis(view, slots, lang) {
  if (!slots.length) return [];
  if (view === "day") {
    const out = [];
    for (let i = 0; i < slots.length; i++) {
      const h = new Date(slots[i]).getHours();
      if (h % 6 === 0) out.push({ i, text: String(h).padStart(2, "0") });
    }
    return out;
  }
  if (view === "week") {
    const f = new Intl.DateTimeFormat(lang, { weekday: "narrow" });
    return slots.map((t, i) => ({ i, text: f.format(new Date(t)) }));
  }
  if (view === "year") {
    const f = new Intl.DateTimeFormat(lang, { month: "narrow" });
    return slots.map((t, i) => ({ i, text: f.format(new Date(t)) }));
  }
  const idx = [0, Math.floor((slots.length - 1) / 2), slots.length - 1];
  return [...new Set(idx)].map((i) => ({ i, text: String(new Date(slots[i]).getDate()) }));
}

// ── i18n ──
const PANEL_I18N = {
  it: {
    day: "Giorno", week: "Settimana", month: "Mese", year: "Anno",
    noData: "Nessun dato", loading: "Caricamento…",
    vsDay: "vs ieri", vsWeek: "vs sett. scorsa", vsMonth: "vs mese scorso", vsYear: "vs anno scorso",
    prev: "Periodo precedente", next: "Periodo successivo",
  },
  en: {
    day: "Day", week: "Week", month: "Month", year: "Year",
    noData: "No data", loading: "Loading…",
    vsDay: "vs yesterday", vsWeek: "vs last week", vsMonth: "vs last month", vsYear: "vs last year",
    prev: "Previous period", next: "Next period",
  },
  zh: {
    day: "日", week: "周", month: "月", year: "年",
    noData: "无数据", loading: "加载中…",
    vsDay: "较昨日", vsWeek: "较上周", vsMonth: "较上月", vsYear: "较去年",
    prev: "上一时段", next: "下一时段",
  },
};
function panelLang(hass) {
  const l = (hass && hass.language ? hass.language : "en").split("-")[0];
  return PANEL_I18N[l] ? l : "en";
}
function panelT(hass, key) {
  const pack = PANEL_I18N[panelLang(hass)] || PANEL_I18N.en;
  return pack[key] || PANEL_I18N.en[key] || key;
}
function panelNum(hass, v, frac) {
  try {
    return Number(v).toLocaleString((hass && hass.language) || "en", {
      maximumFractionDigits: frac, minimumFractionDigits: frac,
    });
  } catch (_) {
    return String(v);
  }
}

// ── Element ──
const PANEL_VIEWS = ["day", "week", "month", "year"];
const PANEL_TTL = 15 * 60 * 1000; // how long the current period stays cached

class EnergyStatsPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._entity = null;
    this._view = "day";
    this._anchor = null;   // ms inside the displayed period
    this._data = null;     // {slots, values, total, prevTotal, hasData, at}
    this._sel = null;      // selected bar index, or null
    this._loading = false;
    this._cache = new Map();
    this._built = false;
    this._el = {};
  }

  // Bind the panel to a statistic. Always reopens on the Day view at "now" —
  // the chosen tab is deliberately not persisted.
  setup(hass, entityId) {
    this._hass = hass;
    if (this._entity !== entityId) this._cache.clear();
    this._entity = entityId;
    this._view = "day";
    this._anchor = Date.now();
    this._sel = null;
    this._data = null;
    // Set before the first paint: without it the panel flashes "no data" for a
    // frame before _load() gets a chance to mark itself busy.
    this._loading = true;
    this._render();
    this._load();
  }

  set hass(h) { this._hass = h; }

  // Called by the host card's periodic timer: only the period containing "now"
  // can be stale.
  refreshIfCurrent() {
    if (!this._entity || this._anchor === null) return;
    const start = panelPeriodStart(this._view, this._anchor);
    if (!panelIsCurrent(this._view, start, Date.now())) return;
    this._cache.delete(`${this._view}|${start}`);
    this._load();
  }

  async _load() {
    if (!this._hass || !this._entity || this._anchor === null) return;
    const w = panelWindow(this._view, this._anchor);
    const key = `${this._view}|${w.start}`;
    const cached = this._cache.get(key);
    const stale = cached && panelIsCurrent(this._view, w.start, Date.now())
      && Date.now() - cached.at > PANEL_TTL;
    if (cached && !stale) {
      this._data = cached;
      this._render();
      return;
    }
    this._loading = true;
    this._render();
    try {
      const res = await this._hass.callWS({
        type: "recorder/statistics_during_period",
        start_time: new Date(w.prevStart).toISOString(),
        end_time: new Date(w.end).toISOString(),
        statistic_ids: [this._entity],
        period: w.period,
        types: ["change"],
        units: { energy: "kWh" },
      });
      const buckets = (res && res[this._entity]) || [];
      const slots = panelSlots(this._view, w.start);
      const prevSlots = panelSlots(this._view, w.prevStart);
      const values = panelFill(slots, buckets, w.end);
      const prevValues = panelFill(prevSlots, buckets, w.start);
      const sum = (a) => a.reduce((x, y) => x + y, 0);
      const hasData = buckets.some((b) => {
        const t = panelBucketMs(b && b.start);
        return t !== null && t >= w.start && t < w.end;
      });
      this._data = {
        slots, values,
        total: sum(values),
        prevTotal: sum(prevValues),
        hasData,
        at: Date.now(),
      };
      this._cache.set(key, this._data);
    } catch (_) {
      // recorder unavailable, or the statistic has no history yet.
      this._data = {
        slots: panelSlots(this._view, w.start),
        values: [], total: 0, prevTotal: 0, hasData: false, at: Date.now(),
      };
    } finally {
      this._loading = false;
      this._render();
    }
  }

  _setView(view) {
    if (this._view === view) return;
    this._view = view;
    this._anchor = Date.now();
    this._sel = null;
    this._load();
  }

  _step(delta) {
    const start = panelPeriodStart(this._view, this._anchor);
    this._anchor = panelShift(this._view, start, delta);
    this._sel = null;
    this._load();
  }

  _build() {
    const hass = this._hass;
    this.shadowRoot.innerHTML = `
<style>
:host{ display:block; }
.wrap{ padding:4px 14px 12px; }
.tabs{ display:flex; gap:2px; background:var(--divider-color,rgba(120,120,120,.16));
  border-radius:9px; padding:2px; margin-bottom:12px; }
.tab{ flex:1 1 0; min-width:0; border:none; cursor:pointer; padding:6px 4px;
  border-radius:7px; background:transparent; color:var(--secondary-text-color);
  font-size:12px; font-family:inherit; white-space:nowrap; overflow:hidden;
  text-overflow:ellipsis; transition:background .15s ease,color .15s ease; }
.tab.sel{ background:var(--card-background-color,#232640); color:var(--primary-text-color); font-weight:500; }
.head{ display:flex; align-items:baseline; justify-content:space-between; gap:8px; margin-bottom:10px; }
.total{ font-size:20px; font-weight:500; color:var(--primary-text-color); white-space:nowrap; }
.total .u{ font-size:12px; font-weight:400; color:var(--secondary-text-color); margin-left:3px; }
.delta{ font-size:12px; color:var(--secondary-text-color); white-space:nowrap;
  overflow:hidden; text-overflow:ellipsis; }
.delta.up{ color:var(--error-color,#e25555); }
.delta.down{ color:var(--success-color,#3fae62); }
.chart{ display:flex; flex-direction:column; height:110px; }
.bars{ flex:1 1 auto; display:flex; align-items:flex-end; gap:2px; min-height:0; cursor:pointer; }
.bar{ flex:1 1 0; min-width:0; min-height:2px; border-radius:3px 3px 0 0;
  background:var(--state-icon-color,#4a90d9); opacity:.35; transition:opacity .15s ease; }
.bar.now{ opacity:1; }
.bar.sel{ opacity:1; background:var(--primary-color,#f9a825); }
.axis{ flex:0 0 auto; position:relative; height:14px; margin-top:4px; }
.axis span{ position:absolute; transform:translateX(-50%); font-size:10px;
  color:var(--disabled-text-color,#5c5e76); white-space:nowrap; }
.empty{ flex:1 1 auto; display:flex; align-items:center; justify-content:center;
  font-size:12px; color:var(--disabled-text-color,#5c5e76); }
.nav{ display:flex; align-items:center; justify-content:center; gap:4px; margin-top:10px; }
.nav button{ border:none; background:transparent; cursor:pointer; padding:4px 8px;
  color:var(--secondary-text-color); border-radius:6px; }
.nav button:disabled{ opacity:.28; cursor:default; }
.nav .lbl{ min-width:130px; text-align:center; font-size:13px; color:var(--primary-text-color); }
.nav ha-icon{ --mdc-icon-size:18px; }
</style>
<div class="wrap">
  <div class="tabs" id="tabs"></div>
  <div class="head">
    <div class="total" id="total"></div>
    <div class="delta" id="delta"></div>
  </div>
  <div class="chart" id="chart"></div>
  <div class="nav">
    <button id="prev" type="button" title="${panelT(hass, "prev")}"><ha-icon icon="mdi:chevron-left"></ha-icon></button>
    <div class="lbl" id="lbl"></div>
    <button id="next" type="button" title="${panelT(hass, "next")}"><ha-icon icon="mdi:chevron-right"></ha-icon></button>
  </div>
</div>`;
    const r = this.shadowRoot;
    this._el = {
      tabs: r.getElementById("tabs"),
      total: r.getElementById("total"),
      delta: r.getElementById("delta"),
      chart: r.getElementById("chart"),
      prev: r.getElementById("prev"),
      next: r.getElementById("next"),
      lbl: r.getElementById("lbl"),
    };
    for (const v of PANEL_VIEWS) {
      const b = document.createElement("button");
      b.className = "tab";
      b.type = "button";
      b.dataset.view = v;
      b.textContent = panelT(hass, v);
      b.addEventListener("click", () => this._setView(v));
      this._el.tabs.appendChild(b);
    }
    this._el.prev.addEventListener("click", () => this._step(-1));
    this._el.next.addEventListener("click", () => this._step(1));
    this._built = true;
  }

  _render() {
    if (!this._hass || !this._entity) return;
    if (!this._built) this._build();
    const hass = this._hass;
    const lang = panelLang(hass);
    const start = panelPeriodStart(this._view, this._anchor);

    for (const b of this._el.tabs.children) {
      b.classList.toggle("sel", b.dataset.view === this._view);
    }

    if (this._loading && !this._data) {
      this._el.total.textContent = panelT(hass, "loading");
      this._el.delta.textContent = "";
    } else if (!this._data || !this._data.hasData) {
      this._el.total.textContent = panelT(hass, "noData");
      this._el.delta.textContent = "";
    } else if (this._sel !== null && this._data.values[this._sel] !== undefined) {
      this._el.total.innerHTML =
        `${panelSlotLabel(this._view, this._data.slots[this._sel], lang)} · ` +
        `${panelNum(hass, this._data.values[this._sel], 2)}<span class="u">kWh</span>`;
      this._el.delta.textContent = "";
    } else {
      this._el.total.innerHTML =
        `${panelNum(hass, this._data.total, 2)}<span class="u">kWh</span>`;
      const pct = panelDelta(this._data.total, this._data.prevTotal);
      if (pct === null) {
        this._el.delta.textContent = "";
        this._el.delta.className = "delta";
      } else {
        const key = "vs" + this._view.charAt(0).toUpperCase() + this._view.slice(1);
        const arrow = pct >= 0 ? "▲" : "▼";
        this._el.delta.textContent =
          `${arrow} ${panelNum(hass, Math.abs(pct), 0)}% ${panelT(hass, key)}`;
        this._el.delta.className = "delta " + (pct >= 0 ? "up" : "down");
      }
    }

    this._el.lbl.textContent = panelPeriodLabel(this._view, start, lang);
    this._el.next.disabled = panelIsCurrent(this._view, start, Date.now());
    this._renderChart();
  }

  _renderChart() {
    const c = this._el.chart;
    if (!this._data || !this._data.hasData || !this._data.slots.length) {
      c.innerHTML = `<div class="empty">${panelT(this._hass, "noData")}</div>`;
      return;
    }
    const { slots, values } = this._data;
    const max = Math.max(...values, 0);
    const now = Date.now();
    const showNow = panelIsCurrent(this._view, panelPeriodStart(this._view, this._anchor), now);

    // Index of the slot containing "now" — the bar the Tuya app paints solid.
    let nowIdx = -1;
    if (showNow) {
      for (let i = 0; i < slots.length; i++) if (slots[i] <= now) nowIdx = i;
    }

    const bars = values.map((v, i) => {
      const h = max > 0 ? Math.round((v / max) * 100) : 0;
      const cls = "bar" + (i === this._sel ? " sel" : i === nowIdx ? " now" : "");
      return `<div class="${cls}" data-i="${i}" style="height:${h}%"></div>`;
    }).join("");

    const ticks = panelAxis(this._view, slots, panelLang(this._hass)).map((t) => {
      // Centre of slot t.i, as a percentage of the bars row.
      const pos = ((t.i + 0.5) / slots.length) * 100;
      return `<span style="left:${pos.toFixed(2)}%">${t.text}</span>`;
    }).join("");

    c.innerHTML = `<div class="bars" id="bars">${bars}</div><div class="axis">${ticks}</div>`;
    this.shadowRoot.getElementById("bars").addEventListener("click", (e) => {
      const el = e.target.closest(".bar");
      if (!el) return;
      const i = Number(el.dataset.i);
      this._sel = this._sel === i ? null : i;   // second tap deselects
      this._render();
    });
  }
}

customElements.define("energy-stats-panel", EnergyStatsPanel);
