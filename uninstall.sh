#!/bin/bash
# Remove this plugin's link and loader entry from a DSH profile.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
PKG_NAME="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['name'])" "$HERE/package.json" 2>/dev/null)"
PROFILE="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/desktop}"
NM="$PROFILE/node_modules"
PATCH="$PROFILE/cordis.patch.yml"

[ -n "$PKG_NAME" ] || { echo "cannot read package.json name"; exit 1; }
rm -f "$NM/$PKG_NAME"
echo "removed link $NM/$PKG_NAME"

[ -f "$PATCH" ] || exit 0
python3 - "$PATCH" "$PKG_NAME" <<'PY'
import sys
path, name = sys.argv[1], sys.argv[2]
lines = open(path, encoding='utf-8').read().splitlines()
out, i, removed = [], 0, False
while i < len(lines):
    if lines[i].strip() == f'name: {name}':
        while out and (out[-1].strip().startswith('- id:')
                       or out[-1].strip() == '- insert:'
                       or out[-1].strip().startswith('# ')):
            out.pop()
        i += 1
        removed = True
        continue
    out.append(lines[i])
    i += 1
while out and out[-1].strip() == '':
    out.pop()
open(path, 'w', encoding='utf-8').write('\n'.join(out) + '\n')
print('removed entry from cordis.patch.yml' if removed else 'entry not present in cordis.patch.yml')
PY
echo "restart the DSH app to unload it"
