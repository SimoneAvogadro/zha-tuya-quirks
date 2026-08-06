/**
 * ZHA Tuya Cards for Home Assistant
 * Generic Lovelace cards bundled with the ZHA Tuya Quirks integration.
 *
 * https://github.com/SimoneAvogadro/zha-tuya-quirks
 */

// --- energy-stats-panel.js ---
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

// --- power-switch-card.js ---
/**
 * Power Switch Card for Home Assistant
 * A compact tile for any on/off switch that also has an instantaneous power
 * sensor on the same device. Shows the toggle + name + "state · power" like the
 * stock tile, and — when the card is wide enough — today's energy on the right.
 *
 * Today's energy is computed from the device's cumulative energy meter
 * (today = meter_now − meter_at_local_midnight) via HA recorder statistics, so
 * no utility_meter / helper is required. Devices without an energy meter simply
 * omit the daily figure.
 *
 * Generic: works for any switch + power sensor pair (energy optional). Entities
 * are resolved from the switch's *device* (not by name suffix), so it tolerates
 * id mismatches like switch.<x>_switch ↔ sensor.<x>_power.
 *
 * Pure HTMLElement + Shadow DOM (no LitElement, no build tools).
 */

// ── i18n ──
const I18N = {
  it: {
    on: "Acceso", off: "Spento", today: "Oggi", offline: "Non disponibile",
    stats: "Statistiche consumi",
    editorDevice: "Presa / interruttore", editorSelect: "— Seleziona —",
    editorHint: "Mostra solo i dispositivi con un sensore di potenza",
    editorNoDevice: "Nessun dispositivo con misura di potenza",
    editorName: "Nome (opzionale)", editorNamePh: "Nome personalizzato",
    editorNameHint: "Lascia vuoto per usare il nome del dispositivo",
    configError: "Seleziona una presa nella configurazione",
    defaultName: "Presa",
    cardDesc: "Tile per prese on/off con potenza istantanea e consumo giornaliero",
  },
  en: {
    on: "On", off: "Off", today: "Today", offline: "Unavailable",
    stats: "Energy statistics",
    editorDevice: "Socket / switch", editorSelect: "— Select —",
    editorHint: "Shows only devices that have a power sensor",
    editorNoDevice: "No device with power measurement found",
    editorName: "Name (optional)", editorNamePh: "Custom name",
    editorNameHint: "Leave empty to use the device name",
    configError: "Select a socket in the configuration",
    defaultName: "Socket",
    cardDesc: "Tile for on/off sockets with live power and daily energy",
  },
  zh: {
    on: "开启", off: "关闭", today: "今天", offline: "不可用",
    stats: "用电统计",
    editorDevice: "插座 / 开关", editorSelect: "— 选择 —",
    editorHint: "仅显示具有功率传感器的设备",
    editorNoDevice: "未找到带功率测量的设备",
    editorName: "名称（可选）", editorNamePh: "自定义名称",
    editorNameHint: "留空使用设备名称",
    configError: "请在配置中选择一个插座",
    defaultName: "插座",
    cardDesc: "适用于带实时功率和每日能耗的开关插座卡片",
  },
};
function _i18nLang(hass) {
  const lang = hass?.language?.split("-")[0] || "en";
  return I18N[lang] ? lang : "en";
}
function _t(hass, key) { return (I18N[_i18nLang(hass)] || I18N.en)[key] || I18N.en[key] || key; }

// ── Entity resolution (device-based) ──
function _registry(hass) { return (hass && hass.entities) || {}; }
function _deviceOf(hass, entityId) { return _registry(hass)[entityId]?.device_id || null; }
function _deviceEntities(hass, deviceId) {
  const reg = _registry(hass);
  return Object.keys(reg).filter((eid) => reg[eid].device_id === deviceId);
}
function _entCategory(hass, entityId) { return _registry(hass)[entityId]?.entity_category || null; }

// Find the power sensor (device_class=power) on the switch's device. Falls back
// to the conventional <object_id>_power suffix when the registry is unavailable.
function findPower(hass, switchId) {
  const dev = _deviceOf(hass, switchId);
  if (dev) {
    for (const eid of _deviceEntities(hass, dev)) {
      if (!eid.startsWith("sensor.")) continue;
      if (hass.states[eid]?.attributes?.device_class === "power") return eid;
    }
  }
  const guess = "sensor." + switchId.slice("switch.".length) + "_power";
  return hass.states[guess] ? guess : null;
}
// Find a cumulative energy meter (device_class=energy, state_class total*) on
// the switch's device. Falls back to the <object_id>_summation_delivered suffix.
function findEnergy(hass, switchId) {
  const dev = _deviceOf(hass, switchId);
  if (dev) {
    for (const eid of _deviceEntities(hass, dev)) {
      if (!eid.startsWith("sensor.")) continue;
      const a = hass.states[eid]?.attributes;
      if (a?.device_class === "energy" && ["total", "total_increasing"].includes(a?.state_class)) return eid;
    }
  }
  const guess = "sensor." + switchId.slice("switch.".length) + "_summation_delivered";
  return hass.states[guess] ? guess : null;
}
// A switch is a candidate if its device has a power sensor and it isn't a config
// entity (excludes child-lock and similar settings toggles).
function isCandidate(hass, switchId) {
  if (_entCategory(hass, switchId) === "config") return false;
  if (switchId.endsWith("_child_lock")) return false;
  return !!findPower(hass, switchId);
}
function findCompatible(hass) {
  return Object.keys(hass.states).filter((e) => e.startsWith("switch.")).filter((e) => isCandidate(hass, e));
}

// ── number / value helpers ──
function _num(hass, v, maxFrac) {
  try { return Number(v).toLocaleString(hass?.language || "en", { maximumFractionDigits: maxFrac, minimumFractionDigits: 0 }); }
  catch (_) { return String(v); }
}
function _stateVal(hass, eid) {
  const s = eid && hass?.states[eid];
  if (!s) return null;
  if (["unavailable", "unknown", "none", ""].includes(s.state)) return null;
  const v = parseFloat(s.state);
  return isNaN(v) ? null : v;
}

// ── Editor ──
class PowerSwitchCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._domBuilt = false;
    this._el = {};
    this._lastCompatKey = "";
  }
  set hass(h) { this._hass = h; this._update(); }
  setConfig(c) { this._config = { ...c }; this._update(); }

  _buildDom() {
    const t = (k) => _t(this._hass, k);
    this.shadowRoot.innerHTML = `
<style>
.editor{padding:16px;font-family:var(--paper-font-body1_-_font-family,sans-serif)}
.row{margin-bottom:16px}
label{display:block;font-size:12px;font-weight:500;color:var(--secondary-text-color);margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em}
select,input[type="text"]{width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--divider-color,rgba(255,255,255,.06));background:var(--card-background-color,#232640);color:var(--primary-text-color);font-size:14px;font-family:monospace;outline:none;box-sizing:border-box}
select:focus,input:focus{border-color:#4a90d9}
.hint{font-size:11px;color:var(--disabled-text-color,#5c5e76);margin-top:4px}
.empty{font-size:13px;color:var(--disabled-text-color);padding:12px;text-align:center;background:var(--divider-color,rgba(255,255,255,.06));border-radius:8px}
[hidden]{display:none!important}
</style>
<div class="editor">
  <div class="row">
    <label>${t("editorDevice")}</label>
    <div id="sw-wrap">
      <select id="sw"></select>
      <div class="hint">${t("editorHint")}</div>
    </div>
    <div id="sw-empty" class="empty" hidden>${t("editorNoDevice")}</div>
  </div>
  <div class="row">
    <label>${t("editorName")}</label>
    <input type="text" id="nm" placeholder="${t("editorNamePh")}">
    <div class="hint">${t("editorNameHint")}</div>
  </div>
</div>`;
    const r = this.shadowRoot;
    this._el = {
      sw: r.getElementById("sw"),
      swWrap: r.getElementById("sw-wrap"),
      swEmpty: r.getElementById("sw-empty"),
      nm: r.getElementById("nm"),
    };
    this._el.sw.addEventListener("change", (e) => {
      this._config = { ...this._config, switch: e.target.value };
      this._fire();
    });
    this._el.nm.addEventListener("input", (e) => {
      if (e.target.value) this._config = { ...this._config, name: e.target.value };
      else { const { name, ...rest } = this._config; this._config = rest; }
    });
    this._el.nm.addEventListener("change", () => this._fire());
    this._domBuilt = true;
  }

  _update() {
    if (!this._hass) return;
    if (!this._domBuilt) this._buildDom();
    const compat = findCompatible(this._hass);
    const cur = this._config.switch || "";
    const nm = this._config.name || "";
    const ae = this.shadowRoot.activeElement;
    const hasCompat = compat.length > 0;

    this._el.swWrap.hidden = !hasCompat;
    this._el.swEmpty.hidden = hasCompat;

    if (hasCompat) {
      const key = compat.join("|");
      if (key !== this._lastCompatKey) {
        const t = (k) => _t(this._hass, k);
        const opts = [`<option value="">${t("editorSelect")}</option>`];
        for (const s of compat) {
          const n = this._hass.states[s]?.attributes?.friendly_name || s;
          opts.push(`<option value="${s}">${n}</option>`);
        }
        this._el.sw.innerHTML = opts.join("");
        this._lastCompatKey = key;
      }
      if (ae !== this._el.sw && this._el.sw.value !== cur) this._el.sw.value = cur;
    }
    if (ae !== this._el.nm && this._el.nm.value !== nm) this._el.nm.value = nm;
  }

  _fire() { this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true })); }
}
customElements.define("power-switch-card-editor", PowerSwitchCardEditor);

// ── Main Card ──
class PowerSwitchCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = null;
    this._entities = null;
    this._domCreated = false;
    this._el = {};
    // Today's-energy state. _baseline = meter value (kWh) at local midnight;
    // today = max(0, meter_now − _baseline), recomputed live on each hass push.
    this._baseline = null;
    this._baselineDay = null;
    this._today = null;
    this._resyncing = false;
    this._timer = null;
    this._expanded = false;
    this._panel = null;
  }

  static getConfigElement() { return document.createElement("power-switch-card-editor"); }
  static getStubConfig() { return { switch: "" }; }

  setConfig(config) {
    if (!config || !config.switch) throw new Error(_t(this._hass, "configError"));
    this._config = { ...config };
    this._entities = null;
    this._domCreated = false;
    this._baseline = null;
    this._baselineDay = null;
    this._today = null;
    this._expanded = false;
    this._panel = null;
    if (this._hass) { this._resolve(); this._render(); }
  }

  // Resolve power/energy from the switch's device, honouring explicit overrides.
  // config.energy === "" disables the daily figure for that card.
  _resolve() {
    if (!this._hass || !this._config) return;
    const sw = this._config.switch;
    const power = this._config.power || findPower(this._hass, sw);
    const energy = "energy" in this._config ? (this._config.energy || null) : findEnergy(this._hass, sw);
    this._entities = { switch: sw, power: power || null, energy: energy || null };
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._entities && this._config) this._resolve();
    if (this._entities) {
      this._recomputeToday();
      if (this._entities.energy && (this._baseline === null || this._baselineDay !== this._dayKey())) {
        this._resyncBaseline();
      }
    }
    this._render();
  }

  connectedCallback() {
    // Re-sync the midnight baseline periodically (covers the day rollover and
    // any meter reset) — the only recurring WebSocket traffic. Live updates
    // between syncs are free (recomputed from cached baseline on each push).
    if (!this._timer) this._timer = setInterval(() => this._resyncBaseline(), 15 * 60 * 1000);
    if (this._entities?.energy && this._baseline === null) this._resyncBaseline();
  }
  disconnectedCallback() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }

  getCardSize() { return 1; }

  _dayKey(d) { const x = d || new Date(); return `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`; }
  _meter() { return _stateVal(this._hass, this._entities?.energy); }

  _recomputeToday() {
    const meter = this._meter();
    if (this._baseline === null || meter === null) return;
    if (meter < this._baseline) { this._resyncBaseline(); return; } // meter reset
    this._today = Math.max(0, meter - this._baseline);
  }

  async _resyncBaseline() {
    if (this._resyncing || !this._hass || !this._entities?.energy) return;
    this._resyncing = true;
    const energyId = this._entities.energy;
    try {
      const now = new Date();
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      const res = await this._hass.callWS({
        type: "recorder/statistics_during_period",
        start_time: midnight.toISOString(),
        end_time: now.toISOString(),
        statistic_ids: [energyId],
        period: "hour",
        types: ["change", "state"],
      });
      const arr = res && res[energyId];
      const meter = this._meter();
      if (Array.isArray(arr) && arr.length) {
        let sum = 0, haveChange = false;
        for (const b of arr) { if (typeof b.change === "number") { sum += b.change; haveChange = true; } }
        if (haveChange && meter !== null) {
          // Derive the midnight meter value so live = meter − baseline tracks
          // consumption between syncs. (today-so-far = sum of hourly `change`.)
          this._baseline = meter - sum;
        } else if (typeof arr[0].state === "number") {
          this._baseline = arr[0].state; // older HA without `change`
        }
        this._baselineDay = this._dayKey(now);
      }
    } catch (_) {
      // recorder/statistics unavailable — leave the daily figure hidden.
    } finally {
      this._resyncing = false;
      if (this._panel && this._expanded) this._panel.refreshIfCurrent();
    }
    this._recomputeToday();
    this._render();
  }

  // ── DOM ──
  _name() {
    if (this._config?.name) return this._config.name;
    const s = this._hass?.states[this._entities.switch];
    return s?.attributes?.friendly_name || _t(this._hass, "defaultName");
  }
  _isOffline() {
    const s = this._hass?.states[this._entities.switch];
    return !s || ["unavailable", "unknown", "none"].includes(s.state);
  }
  _isOn() { return this._hass?.states[this._entities.switch]?.state === "on"; }

  _render() {
    if (!this._hass || !this._entities) return;
    if (!this._domCreated) { this._createDOM(); this._domCreated = true; }
    this._update();
  }

  _createDOM() {
    this.shadowRoot.innerHTML = `
<style>
:host{ container-type: inline-size; display:block; }
ha-card{ overflow:hidden; }
.row{ display:flex; align-items:center; gap:12px; padding:10px 14px; box-sizing:border-box; }
.icon{ flex:0 0 auto; width:40px; height:40px; border-radius:50%; border:none; cursor:pointer;
  display:flex; align-items:center; justify-content:center; padding:0;
  background:var(--divider-color,rgba(120,120,120,.2)); color:var(--secondary-text-color);
  transition:background .2s ease,color .2s ease; }
.icon:hover{ filter:brightness(1.08); }
.icon.on{ background:#f9a825; color:#fff; }
.icon ha-icon{ --mdc-icon-size:22px; }
.info{ flex:1 1 auto; min-width:0; cursor:pointer; }
.name{ font-size:14px; font-weight:500; color:var(--primary-text-color);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.state{ font-size:13px; color:var(--secondary-text-color);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.today{ flex:0 0 auto; display:none; flex-direction:column; align-items:flex-end;
  text-align:right; padding-left:8px; }
.today .val{ font-size:14px; font-weight:500; color:var(--primary-text-color); }
.today .lbl{ font-size:10px; color:var(--secondary-text-color);
  text-transform:uppercase; letter-spacing:.05em; }
.offline .state{ color:var(--error-color,#e25555); }
/* Reveal today's energy only when the card is wide AND a meter exists. */
@container (min-width: 360px){ .root.has-energy .today{ display:flex; } }
.expand{ flex:0 0 auto; width:32px; height:32px; margin-left:2px; padding:0; border:none;
  border-radius:50%; background:transparent; color:var(--secondary-text-color);
  cursor:pointer; display:flex; align-items:center; justify-content:center; }
.expand:hover{ background:var(--divider-color,rgba(120,120,120,.2)); }
.expand[hidden]{ display:none; }
.expand ha-icon{ --mdc-icon-size:20px; }
.panel-wrap{ border-top:1px solid var(--divider-color,rgba(120,120,120,.2)); }
.panel-wrap[hidden]{ display:none; }
</style>
<ha-card>
  <div class="row root" id="root">
    <button class="icon" id="icon" type="button"><ha-icon id="ic" icon="mdi:power-socket-eu"></ha-icon></button>
    <div class="info" id="info">
      <div class="name" id="name"></div>
      <div class="state" id="state"></div>
    </div>
    <div class="today" id="today">
      <div class="val" id="today-val">—</div>
      <div class="lbl" id="today-lbl"></div>
    </div>
    <button class="expand" id="expand" type="button" hidden>
      <ha-icon id="expand-ic" icon="mdi:plus-circle-outline"></ha-icon>
    </button>
  </div>
  <div class="panel-wrap" id="panel-wrap" hidden></div>
</ha-card>`;
    const r = this.shadowRoot;
    this._el = {
      root: r.getElementById("root"),
      icon: r.getElementById("icon"),
      ic: r.getElementById("ic"),
      info: r.getElementById("info"),
      name: r.getElementById("name"),
      state: r.getElementById("state"),
      today: r.getElementById("today"),
      todayVal: r.getElementById("today-val"),
      todayLbl: r.getElementById("today-lbl"),
      expand: r.getElementById("expand"),
      expandIc: r.getElementById("expand-ic"),
      panelWrap: r.getElementById("panel-wrap"),
    };
    this._el.icon.addEventListener("click", (e) => {
      e.stopPropagation();
      this._hass.callService("switch", "toggle", { entity_id: this._entities.switch });
    });
    this._el.info.addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent("hass-more-info", {
        detail: { entityId: this._entities.switch }, bubbles: true, composed: true,
      }));
    });
    this._el.expand.addEventListener("click", (e) => {
      e.stopPropagation();
      this._togglePanel();
    });
  }

  // The panel is created on first expand, never before — a collapsed card costs
  // nothing. It is bound to the meter each time it opens, so a card that was
  // configured before the device had statistics still works.
  _togglePanel() {
    this._expanded = !this._expanded;
    this._el.panelWrap.hidden = !this._expanded;
    this._el.expandIc.setAttribute(
      "icon", this._expanded ? "mdi:minus-circle-outline" : "mdi:plus-circle-outline");
    if (!this._expanded) return;
    if (!this._panel) {
      this._panel = document.createElement("energy-stats-panel");
      this._el.panelWrap.appendChild(this._panel);
    }
    this._panel.setup(this._hass, this._entities.energy);
  }

  _txt(el, v) { if (el && el.textContent !== v) el.textContent = v; }

  _update() {
    const hass = this._hass;
    const swState = hass.states[this._entities.switch];
    const offline = this._isOffline();
    const on = this._isOn();

    // icon
    this._el.root.classList.toggle("offline", offline);
    this._el.icon.classList.toggle("on", on && !offline);
    const icon = swState?.attributes?.icon || "mdi:power-socket-eu";
    if (this._el.ic.getAttribute("icon") !== icon) this._el.ic.setAttribute("icon", icon);

    // name
    this._txt(this._el.name, this._name());

    // state line: "<state> · <power>"
    let stateText;
    if (offline) {
      stateText = _t(hass, "offline");
    } else if (typeof hass.formatEntityState === "function" && swState) {
      stateText = hass.formatEntityState(swState);
    } else {
      stateText = _t(hass, on ? "on" : "off");
    }
    if (!offline) {
      const p = _stateVal(hass, this._entities.power);
      if (p !== null) {
        const unit = hass.states[this._entities.power]?.attributes?.unit_of_measurement || "W";
        const frac = unit === "W" ? 0 : 1;
        stateText += ` · ${_num(hass, p, frac)} ${unit}`;
      }
    }
    this._txt(this._el.state, stateText);

    // today's energy (right side, revealed by container query when wide)
    const hasEnergy = !!this._entities.energy && this._today !== null && !offline;
    this._el.root.classList.toggle("has-energy", hasEnergy);
    if (hasEnergy) {
      const unit = hass.states[this._entities.energy]?.attributes?.unit_of_measurement || "kWh";
      this._txt(this._el.todayVal, `${_num(hass, this._today, 2)} ${unit}`);
      this._txt(this._el.todayLbl, _t(hass, "today"));
    }

    // The toggle is bound to the meter's existence, not to the card's width:
    // a narrow card hides the daily figure but keeps the statistics reachable.
    const hasMeter = !!this._entities.energy;
    this._el.expand.hidden = !hasMeter;
    this._el.expand.title = _t(hass, "stats");
    if (!hasMeter && this._expanded) {
      this._expanded = false;
      this._el.panelWrap.hidden = true;
      this._el.expandIc.setAttribute("icon", "mdi:plus-circle-outline");
    }
    if (this._panel) this._panel.hass = hass;
  }
}

customElements.define("power-switch-card", PowerSwitchCard);
window.customCards = window.customCards || [];
(function () {
  const raw = (function () {
    try { return localStorage.getItem("selectedLanguage"); } catch (_) { return null; }
  })() || navigator.language || "en";
  const lang = raw.replace(/^"|"$/g, "").split("-")[0];
  const pickerName = {
    it: "Presa con consumi (Power Switch)",
    zh: "功率开关卡片 (Power Switch)",
    en: "Power Switch Card",
  }[lang] || "Power Switch Card";
  const pickerDesc = {
    it: I18N.it.cardDesc, zh: I18N.zh.cardDesc, en: I18N.en.cardDesc,
  }[lang] || I18N.en.cardDesc;
  window.customCards.push({ type: "power-switch-card", name: pickerName, description: pickerDesc, preview: true });
})();
console.info("%c POWER-SWITCH-CARD %c v1.1.0 ", "color:white;background:#f9a825;font-weight:bold;padding:2px 6px;border-radius:4px 0 0 4px;", "color:#f9a825;background:#1a1c2e;font-weight:bold;padding:2px 6px;border-radius:0 4px 4px 0;");
