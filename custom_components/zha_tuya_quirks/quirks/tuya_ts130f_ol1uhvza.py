"""Custom quirk for TS130F _TZ3210_ol1uhvza (Lonsonho QS-Zigbee-C03 curtain module).

The upstream quirk (`zhaquirks.tuya.ts130f.TuyaTS130FTOGP`) already fixes the
inverted lift percentage and declares the Tuya-specific attributes on the
WindowCovering cluster, but it does not expose any of them as entities. This
QuirksV2 quirk reuses the upstream `TuyaCoveringCluster` and adds:

- switch  ``motor_reversal``   (0xF002)  swap the up/down outputs (device side)
- switch  ``calibration``      (0xF001)  enter/leave calibration mode (0 = ON)
- number  ``calibration_time`` (0xF003)  travel time, device stores tenths of s
- sensor  ``tuya_moving_state``(0xF000)  Up / Stop / Down
- sensor  opening percentage           derived from the (inverted) lift attribute

Attribute semantics follow Zigbee2MQTT's ``tuya.fz.cover_options`` /
``tuya.tz.cover_reversal`` / ``tuya.tz.cover_calibration`` converters.

Because it is registered for the exact (manufacturer, model) pair it takes
precedence over the upstream model-only match.

Stale idle position
-------------------

On this TS130F firmware, attribute 0x0008 (`current_position_lift_percentage`)
is **not** a live read-out of the motor position. It behaves as a separate,
writable, NVRAM-backed register:

- while the motor runs the firmware *pushes* correct unsolicited reports;
- a ZCL **read**, and the **periodic report** that ZHA's reporting
  configuration asks for (`min 0 / max 900 s / change 1`), both answer with
  whatever was last *written* to the register — not with the real position.

So every 15 minutes the device announces the position it had when the register
was last written (for the unit this quirk was written against: the position at
the time it was migrated off the Tuya cloud), and Home Assistant's cover jumps
back to that value. `read_on_startup` re-poisons it on every HA restart too.
Recalibrating does not help, and there is no OTA image for this manufacturer
id. See home-assistant/core#142224 for the (still open) upstream report.

`PositionGuardCoveringCluster` handles both halves of the problem:

1. **Filter** — a position update that arrives while the motor is at rest and
   contradicts what we already believe is dropped, so it never reaches the
   cover entity. Movement is recognised from the Tuya moving-state attribute
   (0xF000), from lift commands we send, and — as a fallback for wall-switch
   operation that somehow reports no moving state — from two differing
   positions arriving within a few seconds of each other.
2. **Write-back** — a few seconds after the motor stops, the true position is
   written into the device's register. That repairs the NVRAM, so later reads
   and periodic reports carry the right value and the position survives a Home
   Assistant restart. Zigbee2MQTT applies the same remedy for the sibling
   `_TZ3000_yruungrl` firmware ("Also correct the position on the device
   itself, it keeps reporting the stale one otherwise").
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import zigpy.types as t
from zigpy.zcl.clusters.closures import WindowCovering
from zhaquirks.tuya.ts130f import TuyaCoveringCluster

try:  # zha-quirks >= 2.x (HA 2026.x): the v2 builder lives in zhaquirks
    from zhaquirks.builder import (
        EntityPlatform,
        EntityType,
        NumberDeviceClass,
        QuirkBuilder,
    )
except ImportError:  # older zigpy-hosted builder
    from zigpy.quirks.v2 import QuirkBuilder
    from zigpy.quirks.v2.homeassistant import EntityPlatform, EntityType
    from zigpy.quirks.v2.homeassistant.number import NumberDeviceClass

_LOGGER = logging.getLogger(__name__)

_POSITION_ATTR_ID = WindowCovering.AttributeDefs.current_position_lift_percentage.id
_MOVING_ATTR_ID = TuyaCoveringCluster.AttributeDefs.tuya_moving_state.id

# WindowCovering commands that start (or end) a travel. Seeing one of them lets
# the guard trust the position reports that follow even before the device has
# announced its moving state.
_MOVE_COMMAND_IDS = frozenset({0x00, 0x01, 0x02, 0x05, 0x08})

# How long after the last sign of movement position reports are still trusted.
# It only has to cover the settling report the device sends just after it
# announces "Stop"; a full travel is covered by the moving state itself.
_MOVING_GRACE_S = 12.0

# Two *different* positions this close together mean the motor really is
# running, even if no moving-state report announced it.
_BURST_WINDOW_S = 6.0

# Let the motor settle before writing the position back into the device.
_WRITE_BACK_DELAY_S = 5.0

# A write-back triggered by a dropped stale report is rate limited; one
# triggered by the motor stopping is not.
_STALE_WRITE_BACK_MIN_INTERVAL_S = 300.0


class MovingState(t.enum8):
    """Tuya moving state (attribute 0xF000)."""

    Up = 0x00
    Stop = 0x01
    Down = 0x02


class StalePositionGuard:
    """Decide which position updates to believe. Pure logic, no zigpy.

    Kept free of any zigpy/ZHA dependency so it can be exercised directly by
    ``tests/ts130f_position_guard_test.py``.
    """

    def __init__(
        self,
        moving_grace_s: float = _MOVING_GRACE_S,
        burst_window_s: float = _BURST_WINDOW_S,
    ) -> None:
        """Initialise the guard with no movement history."""
        self._moving_grace_s = moving_grace_s
        self._burst_window_s = burst_window_s
        self._moving = False
        self._last_move_ts: float | None = None
        self._held_raw: int | None = None
        self._held_ts: float | None = None

    def note_move_command(self, now: float) -> None:
        """Record that a travel command was just sent to the device."""
        self._last_move_ts = now

    def note_moving_state(self, moving: bool, now: float) -> bool:
        """Record a moving-state report. Returns True when travel just ended."""
        was_moving = self._moving
        self._moving = moving
        self._last_move_ts = now
        return was_moving and not moving

    def _trusts_reports(self, now: float) -> bool:
        """Whether the device is moving, or stopped only a moment ago."""
        if self._moving:
            return True
        return (
            self._last_move_ts is not None
            and now - self._last_move_ts < self._moving_grace_s
        )

    def accepts(self, raw: int, believed_raw: int | None, now: float) -> bool:
        """Whether a position report of ``raw`` percent should be believed.

        ``believed_raw`` is the position currently held for the device in the
        same (raw, device-side) scale, or None when nothing is known yet.
        """
        if self._trusts_reports(now):
            self._held_raw = None
            return True

        if believed_raw is None:
            # Nothing better to go on: a freshly paired device.
            return True

        if raw == believed_raw:
            self._held_raw = None
            return True

        if (
            self._held_raw is not None
            and self._held_ts is not None
            and self._held_raw != raw
            and now - self._held_ts <= self._burst_window_s
        ):
            # Second differing position in quick succession: the motor is
            # running without having announced it. Start trusting again.
            self._last_move_ts = now
            self._held_raw = None
            return True

        self._held_raw = raw
        self._held_ts = now
        return False


class PositionGuardCoveringCluster(TuyaCoveringCluster):
    """Tuya covering cluster that ignores (and repairs) the stale idle position."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        """Initialise the cluster and its position guard."""
        super().__init__(*args, **kwargs)
        self._guard = StalePositionGuard()
        self._write_back_task: asyncio.Task | None = None
        self._last_stale_write_back_ts: float | None = None

    # ── believed position ────────────────────────────────────────────────
    # The upstream cluster caches ``100 - raw``; undo that so the guard and the
    # write-back both work in the device's own scale.

    def _believed_raw(self) -> int | None:
        """The position we currently hold, in the device's own scale."""
        cached = self._attr_cache.get(_POSITION_ATTR_ID)
        return None if cached is None else 100 - cached

    # ── incoming updates ─────────────────────────────────────────────────

    def _update_attribute(self, attrid: int, value: Any) -> None:
        """Drop idle position updates that contradict the known position."""
        if attrid == _MOVING_ATTR_ID:
            self._handle_moving_state(value)
        elif attrid == _POSITION_ATTR_ID:
            if not self._guard.accepts(
                int(value), self._believed_raw(), time.monotonic()
            ):
                _LOGGER.debug(
                    "%s: ignoring idle position report of %s%% "
                    "(stale device register; holding %s%%)",
                    self.endpoint.device.ieee,
                    value,
                    self._believed_raw(),
                )
                self._schedule_write_back(force=False)
                return

        super()._update_attribute(attrid, value)

    def _handle_moving_state(self, value: Any) -> None:
        """Track the motor state and write the position back when it stops."""
        try:
            moving = int(value) != MovingState.Stop
        except (TypeError, ValueError):
            return
        if self._guard.note_moving_state(moving, time.monotonic()):
            self._schedule_write_back(force=True)

    # ── outgoing commands ────────────────────────────────────────────────

    async def command(self, command_id, *args: Any, **kwargs: Any):
        """Trust the reports that follow a travel command we just sent."""
        try:
            is_move = int(command_id) in _MOVE_COMMAND_IDS
        except (TypeError, ValueError):
            is_move = False
        if is_move:
            self._guard.note_move_command(time.monotonic())
        return await super().command(command_id, *args, **kwargs)

    # ── write-back ───────────────────────────────────────────────────────

    def _schedule_write_back(self, *, force: bool) -> None:
        """Queue a write of the known position into the device's register."""
        now = time.monotonic()
        if (
            not force
            and self._last_stale_write_back_ts is not None
            and now - self._last_stale_write_back_ts
            < _STALE_WRITE_BACK_MIN_INTERVAL_S
        ):
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:  # no event loop (tests, import time)
            return
        if self._write_back_task is not None and not self._write_back_task.done():
            self._write_back_task.cancel()
        if not force:
            self._last_stale_write_back_ts = now
        self._write_back_task = loop.create_task(self._write_position_back())

    async def _write_position_back(self) -> None:
        """Write the known position into the device so its register matches."""
        try:
            await asyncio.sleep(_WRITE_BACK_DELAY_S)
            raw = self._believed_raw()
            if raw is None:
                return
            await self.write_attributes({_POSITION_ATTR_ID: raw})
            _LOGGER.debug(
                "%s: wrote position %s%% back into the device register",
                self.endpoint.device.ieee,
                raw,
            )
        except asyncio.CancelledError:
            raise
        except Exception as err:  # noqa: BLE001 - never break on a best-effort push
            _LOGGER.debug(
                "%s: writing the position back failed: %s",
                self.endpoint.device.ieee,
                err,
            )


def _opening_percentage(value):
    """Undo the quirk's ZCL inversion: the cluster caches 100 - <device %>."""
    if value is None:
        return None
    return 100 - value


(
    QuirkBuilder("_TZ3210_ol1uhvza", "TS130F")
    .replaces(PositionGuardCoveringCluster)
    .switch(
        attribute_name=TuyaCoveringCluster.AttributeDefs.motor_reversal.name,
        cluster_id=WindowCovering.cluster_id,
        translation_key="motor_reversal",
        fallback_name="Motor reversal",
    )
    .switch(
        attribute_name=TuyaCoveringCluster.AttributeDefs.calibration.name,
        cluster_id=WindowCovering.cluster_id,
        on_value=0,  # Tuya: 0 = calibration ON, 1 = OFF
        off_value=1,
        translation_key="calibration_mode",
        fallback_name="Calibration mode",
    )
    .number(
        attribute_name=TuyaCoveringCluster.AttributeDefs.calibration_time.name,
        cluster_id=WindowCovering.cluster_id,
        min_value=1,
        max_value=600,
        step=1,
        multiplier=0.1,  # device stores tenths of a second
        unit="s",
        device_class=NumberDeviceClass.DURATION,
        translation_key="travel_time",
        fallback_name="Travel time",
    )
    .enum(
        attribute_name=TuyaCoveringCluster.AttributeDefs.tuya_moving_state.name,
        enum_class=MovingState,
        cluster_id=WindowCovering.cluster_id,
        entity_platform=EntityPlatform.SENSOR,
        entity_type=EntityType.DIAGNOSTIC,
        translation_key="moving_state",
        fallback_name="Moving state",
    )
    .sensor(
        attribute_name=WindowCovering.AttributeDefs.current_position_lift_percentage.name,
        cluster_id=WindowCovering.cluster_id,
        attribute_converter=_opening_percentage,
        unit="%",
        suggested_display_precision=0,
        entity_type=EntityType.DIAGNOSTIC,
        translation_key="opening_percentage",
        fallback_name="Opening",
    )
    .add_to_registry()
)
