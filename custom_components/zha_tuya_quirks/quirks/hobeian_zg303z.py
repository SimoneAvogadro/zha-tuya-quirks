"""HOBEIAN ZG-303Z Soil Moisture Sensor quirk.

Observed device behaviour (12h ZHA debug capture, 2026-05-07, plus a
10-day history review of two distinct units, 2026-09-02):

  * The device exposes TWO humidity channels, and they are SWAPPED with
    respect to what their transport suggests:
      - The standard ZCL cluster 0x0405 (RelativeHumidity) carries the
        SOIL moisture. Over 10 days it shows a slow, monotonic decay
        (99 % -> 63 %) after a watering event, a 4-8 point daily swing
        and no diurnal cycle at all - the signature of drying soil.
      - Tuya DP 109 (raw 0-100 %) carries the AIR humidity. It swings
        20-30 points per day, saturates at 99 % every night and bottoms
        out at 13-14h, in perfect anticorrelation with temperature - the
        signature of ambient air.
    Z2M's reference external converter for ZG-303Z
    (Koenkk/zigbee2mqtt#30576) maps DP 109 -> soil moisture, i.e. the
    opposite of what these two units do. Either that converter targets a
    different firmware, or it was never validated against real readings
    in the field. This quirk follows the observed behaviour, not the
    converter.
  * Temperature is emitted both via the standard cluster 0x0402 AND via
    Tuya DP 5 on cluster 0xEF00. The DP value is scaled by 10
    (raw 180 -> 18.0 degC, matching the cluster 0x0402 reading at the
    same instant).
  * The device also periodically emits DP 3 (humidity, redundant with
    cluster 0x0405), DP 9 (temperature unit), DP 15 (battery) and
    DPs 102/104/105/110/111/112 (calibration / sampling / threshold
    config). The Z2M converter maps only DP 5 and DP 109 and ignores the
    rest; this quirk does the same.

Why the unhandled DPs matter:
  Without a registered handler, ZHA sends a ZCL DefaultResponse with
  status UNSUPPORTED_ATTRIBUTE (0x86). The ZG-303Z is a sleepy device
  and does not poll its parent fast enough to retrieve that response,
  which manifests as a cascade of MAC_INDIRECT_TIMEOUT errors and
  floods the radio log (anomaly A2 in findings-2026-05-07).

Why a single 0x0405 cluster with two entry points:
  Soil moisture does not arrive as a Tuya DP - it arrives as genuine ZCL
  attribute reports on cluster 0x0405, and an endpoint can hold only one
  cluster instance per cluster_id. So the swap cannot be expressed as a
  plain DP re-map: the 0x0405 cluster has to keep receiving the radio
  reports (which means keeping bind / configure_reporting real - hence
  CustomCluster, NOT TuyaLocalCluster) and divert them to 0x0408, while
  the DP 109 value is written into 0x0405 through a different door. The
  two doors really are distinct in zigpy / zhaquirks:
    - DP path:    TuyaMCUCluster._dp_2_attr_update ->
                  cluster.update_attribute(attr_name, value)
    - radio path: Cluster.handle_cluster_general_request ->
                  _legacy_apply_quirk_attribute_update ->
                  cluster._update_attribute(attrid, value)
  (radio Read_Attributes responses take the same second path, so the
  initial attribute read ZHA performs on join/startup is diverted too.)

This quirk:
  1. Replaces the native 0x0405 with SwappedHumidityCluster, which
     forwards radio-reported measured_value to SoilMoisture (0x0408)
     and swallows it locally, while accepting DP 109 writes as the
     real air humidity.
  2. Maps DP 109 -> SwappedHumidityCluster.measured_value (air).
  3. Maps DP 5  -> TemperatureMeasurement.measured_value, alongside
     the native 0x0402 reports.
  4. Registers all other observed DPs to a no-op handler so they are
     acknowledged silently instead of triggering UNSUPPORTED.

Resulting HA entities: `sensor.<prefix>_soil_moisture` = soil (from the
0x0405 radio reports), `sensor.<prefix>_humidity` = air (from DP 109).

Deploy: bundled with the zha_tuya_quirks integration (auto-registered on
load). To use it standalone, copy this file to the path configured as
`custom_quirks_path` in HA's `configuration.yaml` (typically
`/config/custom_zha_quirks/`) and restart Home Assistant.
"""

from typing import Any

from zigpy.profiles import zha
from zigpy.quirks import CustomCluster, CustomDevice
from zigpy.zcl.clusters.general import Basic, Identify, PowerConfiguration
from zigpy.zcl.clusters.measurement import RelativeHumidity, SoilMoisture, TemperatureMeasurement

from zhaquirks.const import (
    DEVICE_TYPE,
    ENDPOINTS,
    INPUT_CLUSTERS,
    MODELS_INFO,
    OUTPUT_CLUSTERS,
    PROFILE_ID,
)
from zhaquirks.tuya import TuyaLocalCluster
from zhaquirks.tuya.mcu import (
    DPToAttributeMapping,
    TuyaMCUCluster,
)


class TuyaTemperatureMeasurement(TuyaLocalCluster, TemperatureMeasurement):
    """Tuya-fed Temperature cluster (also receives native 0x0402 reports)."""


class TuyaSoilMoistureCluster(TuyaLocalCluster, SoilMoisture):
    """Soil Moisture cluster, fed by SwappedHumidityCluster's radio forward."""
    cluster_id = SoilMoisture.cluster_id


class SwappedHumidityCluster(CustomCluster, RelativeHumidity):
    """0x0405 with the two humidity channels swapped.

    Radio reports on this cluster carry the SOIL moisture: they are
    diverted to SoilMoisture (0x0408) and swallowed here. The real AIR
    humidity arrives from Tuya DP 109 and is written here.

    Deliberately a CustomCluster, not a TuyaLocalCluster: this cluster
    must keep receiving genuine ZCL reports, so bind() and
    configure_reporting must stay real (LocalDataCluster fakes both).
    """

    _MEASURED_VALUE_ID = RelativeHumidity.AttributeDefs.measured_value.id

    def update_attribute(self, attr_name: str, value: Any) -> None:
        """DP path (TuyaMCUCluster._dp_2_attr_update): DP 109 -> air humidity.

        Calls the base _update_attribute directly, bypassing the radio
        override below, so the DP value lands in this cluster's cache
        and is published as the humidity entity.
        """
        try:
            attr = self.attributes_by_name[attr_name]
        except KeyError:
            self.debug("no such attribute: %s", attr_name)
            return
        super()._update_attribute(attr.id, value)

    def _update_attribute(self, attrid: int, value: Any) -> None:
        """Radio path (Report_Attributes / Read_Attributes_rsp): -> soil.

        measured_value is forwarded to the 0x0408 cluster and NOT stored
        here, so zigpy's report handler sees the attribute as swallowed
        by the quirk and the humidity entity is not touched. Every other
        attribute (min/max, tolerance, cluster_revision) is kept as-is.
        """
        if attrid == self._MEASURED_VALUE_ID:
            self.endpoint.soil_moisture.update_attribute("measured_value", value)
            return
        super()._update_attribute(attrid, value)


# DPs the device emits but for which we don't expose a HA entity. Routed
# to a no-op handler so ZHA does not reply with UNSUPPORTED_ATTRIBUTE
# (the sleepy device fails to retrieve it -> MAC_INDIRECT_TIMEOUT cascade).
_NOOP_DPS = (3, 9, 15, 102, 104, 105, 110, 111, 112)


class SoilMoistureMCUCluster(TuyaMCUCluster):
    """Tuya MCU Cluster for ZG-303Z."""

    dp_to_attribute: dict[int, DPToAttributeMapping] = {
        5: DPToAttributeMapping(
            TuyaTemperatureMeasurement.ep_attribute,
            "measured_value",
            converter=lambda x: x * 10,  # raw 0.1 degC -> ZCL 0.01 degC
        ),
        # DP 109 is the AIR humidity (see module docstring): it goes to
        # the 0x0405 cluster, whose radio reports carry the soil value.
        109: DPToAttributeMapping(
            SwappedHumidityCluster.ep_attribute,
            "measured_value",
            converter=lambda x: x * 100,  # raw 1 % -> ZCL 0.01 %
        ),
    }

    data_point_handlers = {
        5: "_dp_2_attr_update",
        109: "_dp_2_attr_update",
        **{dp: "_dp_noop" for dp in _NOOP_DPS},
    }

    def _dp_noop(self, datapoint) -> None:
        """Silently absorb a DP without mapping it to any attribute."""
        return


class HobeianZG303Z(CustomDevice):
    """HOBEIAN ZG-303Z Soil Moisture Sensor."""

    signature = {
        MODELS_INFO: [("HOBEIAN", "ZG-303Z")],
        ENDPOINTS: {
            1: {
                PROFILE_ID: zha.PROFILE_ID,
                DEVICE_TYPE: 0x0302,
                INPUT_CLUSTERS: [
                    Basic.cluster_id,
                    PowerConfiguration.cluster_id,
                    Identify.cluster_id,
                    TemperatureMeasurement.cluster_id,
                    RelativeHumidity.cluster_id,
                    0xEF00,
                ],
                OUTPUT_CLUSTERS: [
                    Identify.cluster_id,
                ],
            }
        },
    }

    replacement = {
        ENDPOINTS: {
            1: {
                PROFILE_ID: zha.PROFILE_ID,
                DEVICE_TYPE: 0x0302,
                INPUT_CLUSTERS: [
                    Basic.cluster_id,
                    PowerConfiguration.cluster_id,
                    Identify.cluster_id,
                    TuyaTemperatureMeasurement,
                    SwappedHumidityCluster,
                    TuyaSoilMoistureCluster,
                    SoilMoistureMCUCluster,
                ],
                OUTPUT_CLUSTERS: [
                    Identify.cluster_id,
                ],
            }
        }
    }
