"""Constants for the ZHA Tuya Quirks integration."""

DOMAIN = "zha_tuya_quirks"
VERSION = "1.1.0"

# Base URL the bundled Lovelace card bundle is served under (a static path
# rooted at the integration's www/ directory).
URL_BASE = f"/{DOMAIN}"

# Lovelace JS modules to auto-register as dashboard resources. The version is
# appended as a ?v= query string so a bump invalidates the browser cache.
JSMODULES = [
    {"filename": "zha-tuya-cards.js", "version": VERSION},
]
