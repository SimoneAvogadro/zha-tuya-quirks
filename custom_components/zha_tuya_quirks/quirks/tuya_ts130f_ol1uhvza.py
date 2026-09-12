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
"""

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


class MovingState(t.enum8):
    """Tuya moving state (attribute 0xF000)."""

    Up = 0x00
    Stop = 0x01
    Down = 0x02


def _opening_percentage(value):
    """Undo the quirk's ZCL inversion: the cluster caches 100 - <device %>."""
    if value is None:
        return None
    return 100 - value


(
    QuirkBuilder("_TZ3210_ol1uhvza", "TS130F")
    .replaces(TuyaCoveringCluster)
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
