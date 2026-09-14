"""Radio-level helper services for Tuya devices handled by the bundled quirks.

These are the pieces of the irrigation workflow that must talk to the Zigbee
radio directly (zigpy clusters via the ZHA gateway) and therefore belong in
this ZHA-specific integration, not in the platform-agnostic `tuya_irrigation`
one. They are exposed as services so any caller — the irrigation integration,
an automation, Developer Tools — can use them without importing ZHA internals:

    - zha_tuya_quirks.keepalive_poll(entity_id)
        Read a real Basic-cluster attribute (0x0000 `app_version`) over the
        air, bypassing zigpy's attribute cache. ANY reply — even an
        unsupported-attribute status — is a received frame and refreshes ZHA's
        `last_seen`, keeping a sleepy battery device out of `unavailable` on a
        weak link. An entity-level `homeassistant.update_entity` would NOT do
        this: the Tuya quirks answer the On/Off cluster from a local cache
        without touching the radio (verified live).

The clock sync the GiEX QT06 needs before a run is NOT a service: the quirk
itself inserts the time frame in front of every valve-open DP
(GiexEpoch2000MCUCluster.tuya_mcu_command), so every origin — automation,
Assist, the irrigation integration — gets it without coordination.

The service accepts any entity of the target device (the caller typically
passes the valve switch) and resolves it through the entity + device
registries to the IEEE and then to the zha-lib device object. Failures raise
HomeAssistantError so a caller in blocking mode can decide what to do; the
irrigation integration treats it as best-effort and only logs.
"""
from __future__ import annotations

import logging

import voluptuous as vol

from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er

from .const import (
    ATTR_ENTITY_ID,
    DOMAIN,
    SERVICE_KEEPALIVE_POLL,
)

_LOGGER = logging.getLogger(__name__)

ENTITY_SCHEMA = vol.Schema({vol.Required(ATTR_ENTITY_ID): cv.entity_id})

# Endpoint the Basic (0x0000) cluster lives on for every TS0601-family device
# the bundled quirks cover.
_ENDPOINT = 1
_BASIC_CLUSTER = 0x0000


def _resolve_zha_device(hass: HomeAssistant, entity_id: str):
    """Resolve any entity of a Zigbee device to its zha-lib device object.

    Walks entity registry → device registry → Zigbee IEEE → ZHA gateway. ZHA
    is imported lazily so this module can be imported when ZHA is not loaded
    yet. Raises HomeAssistantError with a user-readable reason when a link is
    missing.
    """
    from homeassistant.components.zha.helpers import get_zha_gateway
    from zigpy.types import EUI64

    ent_reg = er.async_get(hass)
    entry = ent_reg.async_get(entity_id)
    if entry is None or entry.device_id is None:
        raise HomeAssistantError(f"{entity_id} is not a registered device entity")
    device = dr.async_get(hass).async_get(entry.device_id)
    if device is None:
        raise HomeAssistantError(f"No device registry entry for {entity_id}")
    ieee_str = next(
        (conn[1] for conn in device.connections if conn[0] == dr.CONNECTION_ZIGBEE),
        None,
    )
    if ieee_str is None:
        ieee_str = next((i[1] for i in device.identifiers if i[0] == "zha"), None)
    if ieee_str is None:
        raise HomeAssistantError(f"{entity_id} does not belong to a ZHA device")
    gateway = get_zha_gateway(hass)
    try:
        zha_device = gateway.get_device(EUI64.convert(ieee_str))
    except KeyError:
        zha_device = None
    if zha_device is None:
        raise HomeAssistantError(f"ZHA gateway has no device {ieee_str}")
    return zha_device


def _cluster(zha_device, cluster_id: int):
    try:
        return zha_device.device.endpoints[_ENDPOINT].in_clusters[cluster_id]
    except KeyError as err:
        raise HomeAssistantError(
            f"Device {zha_device.ieee} has no cluster 0x{cluster_id:04X} on "
            f"endpoint {_ENDPOINT}"
        ) from err


async def _async_keepalive_poll(call: ServiceCall) -> None:
    hass = call.hass
    entity_id: str = call.data[ATTR_ENTITY_ID]
    zha_device = _resolve_zha_device(hass, entity_id)
    basic = _cluster(zha_device, _BASIC_CLUSTER)
    # allow_cache=False forces a genuine over-the-air read. zigpy already
    # applies its extended timeout for sleepy end devices. The reply content
    # is irrelevant — receiving any frame is what refreshes last_seen.
    try:
        await basic.read_attributes(["app_version"], allow_cache=False)
    except Exception as err:  # noqa: BLE001 - surface as a service error
        raise HomeAssistantError(
            f"Keep-alive read to {entity_id} failed: {err}"
        ) from err
    _LOGGER.debug("Keep-alive read ok for %s", entity_id)


def async_register_services(hass: HomeAssistant) -> None:
    """Register the radio helper services (idempotent)."""
    if not hass.services.has_service(DOMAIN, SERVICE_KEEPALIVE_POLL):
        hass.services.async_register(
            DOMAIN, SERVICE_KEEPALIVE_POLL, _async_keepalive_poll, ENTITY_SCHEMA
        )


def async_remove_services(hass: HomeAssistant) -> None:
    """Unregister the radio helper services."""
    hass.services.async_remove(DOMAIN, SERVICE_KEEPALIVE_POLL)
