/**
 * ZHA Tuya Cards for Home Assistant
 * Generic Lovelace cards bundled with the ZHA Tuya Quirks integration.
 *
 * https://github.com/SimoneAvogadro/zha-tuya-quirks
 */

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
  </div>
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
