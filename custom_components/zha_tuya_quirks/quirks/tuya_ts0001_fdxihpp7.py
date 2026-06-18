"""Custom quirk for TS0001 _TZ3000_fdxihpp7 - expose external switch type as select."""

from zigpy.quirks.v2 import QuirkBuilder
import zigpy.types as t
from zhaquirks.tuya import TuyaZBExternalSwitchTypeCluster


class ExternalSwitchType(t.enum8):
    """Tuya external switch type values."""
    Toggle = 0x00       # rocker: flip to change state
    State = 0x01        # rocker: state synchronous
    Momentary = 0x02    # button switch


(
    QuirkBuilder("_TZ3000_fdxihpp7", "TS0001")
    .applies_to("_TZ3000_mkhkxx1p", "TS0001")  # variante nota con stesso problema
    .replaces(TuyaZBExternalSwitchTypeCluster)
    .enum(
        attribute_name="external_switch_type",
        enum_class=ExternalSwitchType,
        cluster_id=TuyaZBExternalSwitchTypeCluster.cluster_id,
        translation_key="external_switch_type",
        fallback_name="External switch type",
    )
    .add_to_registry()
)
