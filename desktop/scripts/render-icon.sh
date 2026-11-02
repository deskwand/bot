#!/usr/bin/env bash
# Rasterise the app-icon master resources/icon.svg into resources/icon.png.
#
# Run this BY HAND after editing the SVG and commit both files. It is NOT part
# of the build: mygo reads the committed resources/icon.png and derives the
# .icns and .ico from it, so a build never needs Chrome.
#
# macOS has no built-in SVG rasteriser (`sips` cannot read SVG); Chrome renders
# the paths and gradients exactly as the browser previews them.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
SRC="$ROOT/resources/icon.svg"
DEST="$ROOT/resources/icon.png"
[[ -x "$CHROME" ]] || { echo "missing Chrome at $CHROME (override with CHROME=...)" >&2; exit 1; }
[[ -f "$SRC" ]] || { echo "missing $SRC" >&2; exit 1; }

STAGE="$(mktemp -d)"
cleanup(){ rm -rf -- "$STAGE"; }
trap cleanup EXIT
cp "$SRC" "$STAGE/icon.svg"

# The wrapper pins the size so Chrome neither crops nor rescales the master.
# --default-background-color=00000000 keeps the alpha channel; without it
# Chrome writes an opaque PNG and the transparent corners turn white.
printf '<!doctype html><meta charset=utf-8><style>*{margin:0}html,body{background:transparent}</style><img src="file://%s/icon.svg" width="1024" height="1024">' "$STAGE" > "$STAGE/one.html"
"$CHROME" --headless --disable-gpu --no-first-run \
  --user-data-dir="$STAGE/prof" --hide-scrollbars \
  --default-background-color=00000000 --allow-file-access-from-files \
  --force-device-scale-factor=1 --window-size=1024,1024 \
  --screenshot="$STAGE/icon.png" "file://$STAGE/one.html" >/dev/null 2>&1
[[ -s "$STAGE/icon.png" ]] || { echo 'Chrome produced no output' >&2; exit 1; }
mv "$STAGE/icon.png" "$DEST"
echo "wrote $DEST"
