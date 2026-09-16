"""Constants for the Tuya ZHA integration."""

DOMAIN = "zha_tuya_quirks"
VERSION = "1.5.0"

# Base URL the bundled Lovelace card bundle is served under (a static path
# rooted at the integration's www/ directory).
URL_BASE = f"/{DOMAIN}"

# Lovelace JS modules to auto-register as dashboard resources. The version is
# appended as a ?v= query string so a bump invalidates the browser cache.
JSMODULES = [
    {"filename": "zha-tuya-cards.js", "version": VERSION},
]

# ── Radio helper services (services.py) ──
# Zigbee-level helpers for the Tuya devices covered by the bundled quirks. The
# tuya_irrigation integration calls them (best-effort, only if registered)
# instead of touching zigpy itself; automations can call them too. (The GiEX
# clock sync before a run is not a service: the quirk does it on every open.)
SERVICE_KEEPALIVE_POLL = "keepalive_poll"
ATTR_ENTITY_ID = "entity_id"
