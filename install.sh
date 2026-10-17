#!/bin/bash
# Link this plugin into a DSH profile and add its loader entry.
# Usage: bash install.sh   (DSH_PROFILE_DIR overrides ~/.dsh/profiles/desktop)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
PKG_NAME="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['name'])" "$HERE/package.json" 2>/dev/null)"
PROFILE="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/desktop}"
NM="$PROFILE/node_modules"
PATCH="$PROFILE/cordis.patch.yml"
STAMP="$(date +%Y%m%d-%H%M%S)"
BK="$PROFILE/.plugin-backup-$STAMP"

[ -n "$PKG_NAME" ] || { echo "cannot read package.json name"; exit 1; }
[ -d "$PROFILE" ] || { echo "profile not found: $PROFILE"; exit 1; }
mkdir -p "$NM" "$BK"
[ -f "$PATCH" ] && cp -p "$PATCH" "$BK/cordis.patch.yml"
ln -sfn "$HERE" "$NM/$PKG_NAME"

if grep -q "name: $PKG_NAME" "$PATCH" 2>/dev/null; then
  echo "$PKG_NAME already present in cordis.patch.yml"
else
  cat >> "$PATCH" <<YAML

# $PKG_NAME
- insert:
    - id: $PKG_NAME
      name: $PKG_NAME
YAML
  echo "added $PKG_NAME to cordis.patch.yml"
fi

echo "installed $PKG_NAME -> $NM/$PKG_NAME"
echo "refresh the DSH window (or restart the app) to load it"
echo "backup: $BK"
