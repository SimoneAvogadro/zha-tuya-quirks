"""ZHA Tuya Quirks custom integration.

This integration ships custom ZHA quirks for Tuya Zigbee devices. Its primary
job is to make sure the bundled quirk modules are imported, which registers
them into zigpy's global registry so ZHA applies them on device join /
interrogation — exactly as if they had been dropped into the directory
configured by `zha.custom_quirks_path`.

The quirks register themselves as a side-effect of being imported (a
`CustomDevice` subclass definition, or a `QuirkBuilder(...).add_to_registry()`
call). The import below must therefore happen at module load time, before ZHA
enumerates devices — which it does, because Home Assistant imports this module
when the integration is set up.

In addition to the quirks, the integration serves a small bundle of generic
Lovelace cards (see `www/zha-tuya-cards.js`) and auto-registers it as a
dashboard resource, so users don't have to add the resource manually. The card
sources live in `src/` and are concatenated into the bundle by `build.sh`.

The config flow exists only so the integration can be enabled from the UI with
a single click.
"""
from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.setup import async_when_setup

from .const import JSMODULES, URL_BASE

# Import for side-effect: registers bundled ZHA quirks into zigpy's global
# registry. Needs to happen at module load time so ZHA picks them up before
# enumerating devices.
from . import quirks  # noqa: F401

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up the integration from a config entry.

    The actual quirk registration already happened at import time (see the
    `from . import quirks` above). Here we additionally serve and auto-register
    the bundled Lovelace card so it shows up in the dashboard card picker.
    """
    await _async_register_frontend(hass)
    _LOGGER.debug("ZHA Tuya Quirks enabled (quirks registered at import time)")
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry.

    Quirk registration cannot be cleanly undone (zigpy's registry has no public
    de-registration API) and persists for the lifetime of the HA process. The
    static path and the Lovelace resource likewise stay registered — HA exposes
    no clean way to undo them, and leaving them idle is harmless. A restart is
    required to fully remove the quirks.
    """
    return True


async def _async_register_frontend(hass: HomeAssistant) -> None:
    """Serve the bundle via a static path and auto-register it as a Lovelace module.

    The static path can be registered during async_setup_entry, but the
    Lovelace resource registration has to wait until the lovelace component
    itself is set up, hence the async_when_setup deferral.
    """
    www_dir = Path(__file__).parent / "www"
    try:
        await hass.http.async_register_static_paths(
            [StaticPathConfig(URL_BASE, str(www_dir), False)]
        )
    except RuntimeError:
        _LOGGER.debug("Static path %s already registered", URL_BASE)

    async_when_setup(hass, "lovelace", _async_register_lovelace_resource)


async def _async_register_lovelace_resource(
    hass: HomeAssistant, _component: str
) -> None:
    """Register the card bundle as a Lovelace module resource.

    Invoked after the lovelace component has finished setting up, so
    hass.data["lovelace"] is guaranteed to be the LovelaceData dataclass
    (attributes: resource_mode, resources, dashboards, ...).
    """
    lovelace = hass.data.get("lovelace")
    if lovelace is None:
        _LOGGER.warning(
            "Lovelace data missing after setup — cannot auto-register %s",
            URL_BASE,
        )
        return

    # Recent HA versions expose `resource_mode`; older ones exposed `mode`.
    mode = getattr(lovelace, "resource_mode", None) or getattr(lovelace, "mode", None)
    resources = getattr(lovelace, "resources", None)
    if mode != "storage" or resources is None:
        _LOGGER.warning(
            "Lovelace is in '%s' mode; add '%s/zha-tuya-cards.js' as a module "
            "resource manually under Settings → Dashboards → Resources",
            mode,
            URL_BASE,
        )
        return

    try:
        if not resources.loaded:
            await resources.async_load()
    except Exception as err:  # pragma: no cover - defensive against HA API drift
        _LOGGER.warning("Could not load Lovelace resources: %s", err)
        return

    for module in JSMODULES:
        url = f"{URL_BASE}/{module['filename']}"
        versioned_url = f"{url}?v={module['version']}"
        found_id: str | None = None
        try:
            items = resources.async_items()
        except Exception as err:  # pragma: no cover - defensive
            _LOGGER.warning("Could not read Lovelace resources: %s", err)
            return
        for item in items:
            item_url = item.get("url", "")
            if item_url.split("?")[0] == url:
                found_id = item.get("id")
                if item_url == versioned_url:
                    _LOGGER.debug("Resource %s already up to date", versioned_url)
                    found_id = "UPTODATE"
                break
        if found_id == "UPTODATE":
            continue
        try:
            if found_id:
                await resources.async_update_item(
                    found_id, {"res_type": "module", "url": versioned_url}
                )
                _LOGGER.warning("Updated Lovelace resource: %s", versioned_url)
            else:
                await resources.async_create_item(
                    {"res_type": "module", "url": versioned_url}
                )
                _LOGGER.warning("Registered Lovelace resource: %s", versioned_url)
        except Exception as err:  # pragma: no cover - defensive
            _LOGGER.warning(
                "Could not register Lovelace resource %s: %s", versioned_url, err
            )
