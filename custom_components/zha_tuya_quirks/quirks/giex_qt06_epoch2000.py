"""Custom ZHA quirk override: GiEX QT06 / GX02 valve family with 2000-epoch MCU sync.

Symptoms on `_TZE200_a7sghmms` (and other TS0601 GiEX QT06 variants) under ZHA:

  * Battery drains in days/weeks instead of months, even when the valve is idle.
  * `irrigation_end_time` sensor flaps continuously to "today + N hours", with
    rapid back-to-back updates visible in the device's Activity panel.
  * Marginal RSSI (-80 dBm or worse) even when a Tuya router is nearby.

Suspected root cause:
  Tuya MCU devices send `commandMcuSyncTime` (cluster 0xEF00, command 0x24)
  on a periodic schedule. Upstream `TuyaMCUCluster.handle_set_time_request`
  in zha-device-handlers answers using a **1970-01-01 epoch** by default.
  The GiEX firmware family appears to expect a **2000-01-01 epoch** ("Tuya
  epoch") - when it gets a 1970-based timestamp, it discards the response,
  leaves its internal clock at zero, and re-fires `commandMcuSyncTime`
  aggressively. The retry storm explains both the battery drain and the
  bogus end-time values.

  See:
    - https://github.com/zigpy/zha-device-handlers/blob/dev/zhaquirks/tuya/mcu/__init__.py
      (TuyaMCUCluster.handle_set_time_request and the set_time_offset default)
    - https://github.com/Koenkk/zigbee2mqtt/issues/19817
      (Tuya devices flooding when MCU sync requests go unanswered)
    - https://github.com/zigpy/zha-device-handlers/issues/2682
      (analogous time-sync bug in MOES thermostat path)

What this file does:
  Subclasses `TuyaMCUCluster` with `set_time_offset` / `set_time_local_offset`
  pinned to 2000-01-01, then re-registers the upstream `gx02_base_quirk`
  with our cluster as the replacement. zigpy's QuirksV2 registry uses
  last-registered-wins for the same `(manufacturer, model)` tuple; HA loads
  `custom_quirks_path` after upstream zha-device-handlers, so our entry
  takes precedence.

  It also fixes the `irrigation_start_time` / `irrigation_end_time` DPs
  (101/102) by replacing the module-level `giex_string_to_dt` converter that
  upstream's DP lambdas look up by name: upstream hardcodes a +04:00 offset and
  the timestamp sensor errors at HA startup when the persisted value is restored
  as a string. Our replacement builds the datetime in HA's local timezone and
  tolerates already-formatted / restored values. We patch the converter (not the
  DP map) because re-mapping an already-defined DP raises in the QuirksV2 builder
  and would break the integration; the patch is guarded so an upstream rename
  degrades to "tz not fixed", never a crash.

Deploy:
  1. In `configuration.yaml` make sure ZHA points to a custom quirks path:
        zha:
          custom_quirks_path: /config/custom_zha_quirks
     (Pick any path you like; the convention is `/config/custom_zha_quirks`.)

  2. Copy this file to that path:
        /config/custom_zha_quirks/giex_qt06_epoch2000.py

  3. Restart Home Assistant.

  4. Settings -> Devices -> "Irrigatore 31" -> Reconfigure (top-right menu).

  5. Verify in logs (Settings -> System -> Logs, or `home-assistant.log`):
        - Search for "handle_set_time_request" - you should see periodic
          entries from `zhaquirks.tuya.mcu` showing the response payload.
          Without this fix, those entries appear but the device ignores them;
          with the fix, the device's internal clock should start advancing
          and `irrigation_end_time` should stop flapping.
        - Optionally enable debug logging for a clearer view:
            logger:
              logs:
                zhaquirks.tuya: debug
                zigpy.zcl: info

  6. Watch over 24-48h:
        - `irrigation_end_time` sensor stops flapping (changes only when an
          irrigation actually starts/stops).
        - Battery percentage stops dropping at the previous rate.
        - LQI/RSSI may also improve as fewer retransmissions are needed.

Roll back:
  Delete this file from `custom_quirks_path` and restart HA.

Compatibility note:
  Tested against zha-device-handlers `dev` as of April 2026. If upstream
  refactors `gx02_base_quirk` or `TuyaQuirkBuilder.add_to_registry`, this
  override may need updating. Pin a known-good commit in your HA snapshots
  before applying.
"""

from __future__ import annotations

import asyncio
import datetime
import logging
import re

import zigpy.types as t
from zigpy.quirks.v2.homeassistant import UnitOfTime

from homeassistant.util import dt as dt_util

import zhaquirks.tuya.tuya_valve as _tuya_valve
from zhaquirks.tuya.mcu import TuyaMCUCluster
from zhaquirks.tuya.tuya_valve import gx02_base_quirk

_LOGGER = logging.getLogger(__name__)


# Tuya epoch: 2000-01-01 UTC. The default in upstream TuyaMCUCluster is
# 1970-01-01 (Unix epoch); GiEX firmware ignores responses based on it.
_TUYA_EPOCH_UTC = datetime.datetime(2000, 1, 1, tzinfo=datetime.UTC)
_TUYA_EPOCH_LOCAL = datetime.datetime(2000, 1, 1)


# Seconds between the clock frame (0x24) and the valve-open DP, so the MCU has
# applied the pushed time before it stamps irrigation_start_time. The time
# command is fire-and-forget (no ack), hence a fixed settle. Same value the
# tuya_irrigation integration used when it pushed the clock itself.
_OPEN_CLOCK_SETTLE_S = 1.5


class GiexEpoch2000MCUCluster(TuyaMCUCluster):
    """TuyaMCUCluster that answers MCU set_time using the 2000-01-01 epoch
    that the GiEX QT06 firmware family expects, instead of 1970-01-01, and
    that syncs the MCU clock right before every valve open.

    Why here: the GiEX RTC drifts and the firmware never asks for the time, so
    irrigation_start_time / irrigation_end_time are wrong unless the clock is
    pushed just before a run. ZHA does not call bind() on this manufacturer-
    specific 0xEF00 cluster, so a configure-time hook never fires. The one hook
    that provably fires is the valve-open DP write itself: every switch.turn_on
    (card, integration service, automation, Assist) ends up in
    tuya_mcu_command with cluster_attr "on_off" — that is where the clock frame
    is inserted, followed by a short settle, then the DP. No caller has to know.
    """

    set_time_offset = _TUYA_EPOCH_UTC
    set_time_local_offset = _TUYA_EPOCH_LOCAL

    def tuya_mcu_command(self, cluster_data) -> None:
        """Sync the MCU clock before a valve open; pass everything else through."""
        try:
            is_open = (
                cluster_data.cluster_attr == "on_off" and bool(cluster_data.attr_value)
            )
        except AttributeError:  # pragma: no cover - upstream TuyaClusterData drift
            is_open = False
        if not is_open:
            return super().tuya_mcu_command(cluster_data)
        self.create_catching_task(self._async_open_with_clock_sync(cluster_data))
        return None

    async def _async_open_with_clock_sync(self, cluster_data) -> None:
        """Clock frame → settle → the original open command.

        The open must happen whatever the clock push does: any failure is
        logged and the DP is still sent.
        """
        try:
            self.handle_set_time_request(0)
            self.debug("GiEX clock synced before valve open")
            await asyncio.sleep(_OPEN_CLOCK_SETTLE_S)
        except Exception as err:  # noqa: BLE001 - never block the valve open
            self.warning("GiEX clock sync before open failed (%s); opening anyway", err)
        super().tuya_mcu_command(cluster_data)


# Matches upstream tuya_valve.py: 12 hours expressed as seconds.
_GIEX_12HRS_AS_SEC = 12 * 60 * 60


# --- start/end time converter fix ----------------------------------------
#
# Upstream gx02_base_quirk maps DP 101 (irrigation_start_time) and DP 102
# (irrigation_end_time) with `converter=giex_string_to_dt`, a TIMESTAMP
# sensor. The upstream `giex_string_to_dt` has two bugs:
#   1. It hardcodes a +04:00 timezone, ignoring the HA-configured zone.
#   2. On HA restart the persisted state comes back as a *string* into the
#      timestamp sensor, which raises "'str' object has no attribute 'tzinfo'".
#
# We cannot re-map DP 101/102 in our clone (the QuirksV2 builder raises
# "DP <id> is already mapped" and that would break the whole integration).
# Two patches instead, both guarded so upstream drift can only cost the tz fix,
# never the quirk:
#   a. the module-level `giex_string_to_dt` is replaced — enough when upstream
#      wraps it in a lambda that resolves the global at call time (older
#      zhaquirks);
#   b. the DPToAttributeMapping objects for DP 101/102 inside our *cloned*
#      builder get their `converter` swapped — needed since upstream started
#      passing the function object directly (`converter=giex_string_to_dt`),
#      which binds the original at import time and made patch (a) a silent
#      no-op (start/end stamps went back to +04:00, 2 h off in Europe/Rome).
#      This edits the clone's own mapping list (a deepcopy), not upstream's
#      registered quirk, and does not touch the DP map keys.
_GIEX_HHMMSS_RE = re.compile(r"^\s*(\d{1,2}):(\d{2}):(\d{2})\s*$")


def _giex_string_to_dt(value) -> datetime.datetime | None:
    """TZ-correct, restore-tolerant replacement for upstream giex_string_to_dt.

    - Device report "HH:MM:SS" -> today at that time in HA's local timezone.
    - Already a datetime (or an ISO string restored at startup) -> returned as
      a tz-aware datetime.
    - "--:--:--", empty, or anything unparseable -> None (the upstream sentinel).
    """
    if value is None:
        return None
    if isinstance(value, datetime.datetime):
        # Defensive: ensure tz-aware so the timestamp sensor never sees a naive
        # or string value.
        if value.tzinfo is None:
            return value.replace(tzinfo=dt_util.DEFAULT_TIME_ZONE)
        return value
    text = str(value).strip()
    if not text or text.startswith("--"):
        return None
    match = _GIEX_HHMMSS_RE.match(text)
    if match:
        hour, minute, second = (int(g) for g in match.groups())
        if hour > 23 or minute > 59 or second > 59:
            return None
        return dt_util.now().replace(
            hour=hour, minute=minute, second=second, microsecond=0
        )
    # Restore case: an already-formatted datetime/ISO string.
    parsed = dt_util.parse_datetime(text)
    if parsed is not None:
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt_util.DEFAULT_TIME_ZONE)
        return parsed
    return None


# Patch (a): module-level replacement. Defensive: if upstream renames or
# inlines the converter, log and skip rather than raising at import time (which
# would take the whole integration down). Worst case is "tz not fixed", never
# "integration broken".
_UPSTREAM_GIEX_STRING_TO_DT = getattr(_tuya_valve, "giex_string_to_dt", None)
if _UPSTREAM_GIEX_STRING_TO_DT is not None:
    _tuya_valve.giex_string_to_dt = _giex_string_to_dt
else:  # pragma: no cover - guards against upstream API drift
    _LOGGER.warning(
        "zhaquirks.tuya.tuya_valve.giex_string_to_dt not found; GiEX "
        "start/end time timezone fix not applied (upstream API changed)"
    )

# DPs whose converter upstream binds to giex_string_to_dt.
_GIEX_TIME_DPS = (101, 102)


def _patch_time_converters(builder) -> None:
    """Patch (b): swap the converter on the clone's DP 101/102 mappings in place.

    `builder.tuya_dp_to_attribute` is `dict[int, list[DPToAttributeMapping]]`
    and `add_to_registry` copies it onto the replacement MCU cluster class, so
    editing the mapping objects here is what the device's cluster will use.
    Only mappings still pointing at the upstream converter are touched.
    """
    try:
        dp_map = builder.tuya_dp_to_attribute
        patched = 0
        for dp_id in _GIEX_TIME_DPS:
            for mapping in dp_map.get(dp_id, ()):
                if getattr(mapping, "converter", None) is _UPSTREAM_GIEX_STRING_TO_DT:
                    mapping.converter = _giex_string_to_dt
                    patched += 1
        if patched != len(_GIEX_TIME_DPS):
            _LOGGER.warning(
                "GiEX time converter patched on %d/%d DPs; start/end time "
                "timezone fix may be incomplete (upstream layout changed)",
                patched,
                len(_GIEX_TIME_DPS),
            )
    except Exception as err:  # noqa: BLE001 - never break quirk registration
        _LOGGER.warning("GiEX time converter patch skipped: %s", err)


# Re-register the upstream GX02 quirk with our MCU cluster as replacement.
# We clone gx02_base_quirk to inherit all the DPs (battery, metering, on/off,
# cycles, mode, weather delay, duration, start/end time) and add the variant-
# specific DPs (target, interval) the same way upstream does for the
# a7sghmms / 7ytb3h8u family.
_giex_builder = gx02_base_quirk.clone()
_patch_time_converters(_giex_builder)
(
    _giex_builder
    .applies_to("_TZE200_a7sghmms", "TS0601")
    .applies_to("_TZE204_a7sghmms", "TS0601")
    .applies_to("_TZE200_7ytb3h8u", "TS0601")
    .applies_to("_TZE204_7ytb3h8u", "TS0601")
    .applies_to("_TZE284_7ytb3h8u", "TS0601")
    .tuya_number(
        dp_id=104,
        attribute_name="irrigation_target",
        type=t.uint32_t,
        min_value=0,
        max_value=_GIEX_12HRS_AS_SEC,
        step=1,
        translation_key="irrigation_target",
        fallback_name="Irrigation target",
    )
    .tuya_number(
        dp_id=105,
        attribute_name="irrigation_interval",
        type=t.uint32_t,
        min_value=0,
        max_value=_GIEX_12HRS_AS_SEC,
        step=1,
        unit=UnitOfTime.SECONDS,
        translation_key="irrigation_interval",
        fallback_name="Irrigation interval",
    )
    .add_to_registry(replacement_cluster=GiexEpoch2000MCUCluster)
)
