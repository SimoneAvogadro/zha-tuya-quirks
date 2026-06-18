"""ZHA Tuya Quirks custom integration.

This integration ships custom ZHA quirks for Tuya Zigbee devices. Its only
job is to make sure the bundled quirk modules are imported, which registers
them into zigpy's global registry so ZHA applies them on device join /
interrogation — exactly as if they had been dropped into the directory
configured by `zha.custom_quirks_path`.

The quirks register themselves as a side-effect of being imported (a
`CustomDevice` subclass definition, or a `QuirkBuilder(...).add_to_registry()`
call). The import below must therefore happen at module load time, before ZHA
enumerates devices — which it does, because Home Assistant imports this module
when the integration is set up.

There are no services, entities or configuration. The config flow exists only
so the integration can be enabled from the UI with a single click.
"""
from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

# Import for side-effect: registers bundled ZHA quirks into zigpy's global
# registry. Needs to happen at module load time so ZHA picks them up before
# enumerating devices.
from . import quirks  # noqa: F401

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up the integration from a config entry.

    The actual quirk registration already happened at import time (see the
    `from . import quirks` above). This entry exists so the integration is
    visible and manageable from the UI.
    """
    _LOGGER.debug("ZHA Tuya Quirks enabled (quirks registered at import time)")
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry.

    Quirk registration cannot be cleanly undone (zigpy's registry has no public
    de-registration API) and persists for the lifetime of the HA process. A
    restart is required to fully remove the quirks.
    """
    return True
