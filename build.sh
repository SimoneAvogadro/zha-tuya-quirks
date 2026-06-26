#!/usr/bin/env bash
# Builds zha-tuya-cards.js by concatenating all card sources from src/
set -euo pipefail

OUTFILE="zha-tuya-cards.js"

cat > "$OUTFILE" <<'HEADER'
/**
 * ZHA Tuya Cards for Home Assistant
 * Generic Lovelace cards bundled with the ZHA Tuya Quirks integration.
 *
 * https://github.com/SimoneAvogadro/zha-tuya-quirks
 */
HEADER

for f in src/*.js; do
  printf '\n// --- %s ---\n' "$(basename "$f")" >> "$OUTFILE"
  cat "$f" >> "$OUTFILE"
done

# Copy the bundle into the integration's www/ so it can be served by the
# custom_components.zha_tuya_quirks integration and auto-registered as a
# Lovelace resource.
INTG_WWW="custom_components/zha_tuya_quirks/www"
mkdir -p "$INTG_WWW"
cp "$OUTFILE" "$INTG_WWW/$OUTFILE"
echo "Copied $OUTFILE → $INTG_WWW/"

echo "Built $OUTFILE ($(wc -c < "$OUTFILE") bytes, $(ls src/*.js | wc -l) card(s))"
