#!/bin/sh
# Fills the config template with binding names for allowlisted environment
# variables, then hands PID 1 to workerd. Values never pass through this
# script: workerd reads them itself through `fromEnvironment`.
set -eu

APP_DIR=${APP_DIR:-/app}
DATA_DIR=${DATA_DIR:-/data}
LISTEN=${LISTEN:-*:8787}
WORKERD_BIN=${WORKERD_BIN:-workerd}

if [ -z "${PUBLIC_BASE_URL:-}" ]; then
  export PUBLIC_BASE_URL=http://localhost:8787
fi

names_file=$(mktemp)
bindings_file=$(mktemp)
trap 'rm -f "$names_file" "$bindings_file"' EXIT

# Enumerate names through awk: a value containing a newline would otherwise
# look like another variable to `env`. Empty values count as unset.
awk 'BEGIN { for (n in ENVIRON) if (ENVIRON[n] != "") print n }' /dev/null > "$names_file"

valid_name() {
  case "$1" in
    "" | *[!A-Z0-9_]* | [0-9_]*) return 1 ;;
  esac
  return 0
}

allowed() {
  name=$1
  while IFS= read -r entry; do
    case "$entry" in
      "" | "#"*) continue ;;
    esac
    case "$entry" in
      *"*")
        prefix=${entry%"*"}
        case "$name" in
          "$prefix"*) return 0 ;;
        esac
        ;;
      *)
        if [ "$name" = "$entry" ]; then return 0; fi
        ;;
    esac
  done < "$APP_DIR/env-allowlist.txt"
  return 1
}

have_model_key=0
while IFS= read -r name; do
  case "$name" in
    MODEL_KEY_*)
      if valid_name "$name"; then have_model_key=1; fi
      ;;
  esac
done < "$names_file"

missing=""
[ -n "${DESKWAND_CONFIG:-}" ] || missing="$missing DESKWAND_CONFIG"
[ -n "${ADMIN_TOKEN:-}" ] || missing="$missing ADMIN_TOKEN"
[ "$have_model_key" -eq 1 ] || missing="$missing MODEL_KEY_*"
if [ -n "$missing" ]; then
  echo "缺少必填环境变量:$missing" >&2
  exit 1
fi

valid_target() {
  case "$1" in
    *[!]A-Za-z0-9_./:*[-]*) return 1 ;;
  esac
  return 0
}

if ! valid_target "$LISTEN"; then
  echo "LISTEN 含非法字符" >&2
  exit 1
fi
if ! valid_target "$DATA_DIR"; then
  echo "DATA_DIR 含非法字符" >&2
  exit 1
fi

if [ ! -d "$DATA_DIR" ] || [ ! -w "$DATA_DIR" ]; then
  echo "数据目录不可写:$DATA_DIR" >&2
  exit 1
fi

while IFS= read -r name; do
  if ! allowed "$name"; then continue; fi
  if ! valid_name "$name"; then
    echo "跳过非法环境变量名:$name" >&2
    continue
  fi
  printf '    (name = "%s", fromEnvironment = "%s"),\n' "$name" "$name" \
    >> "$bindings_file"
done < "$names_file"

awk -v listen="$LISTEN" -v dir="$DATA_DIR" -v bindings="$bindings_file" '
function replace(text, needle, value,    at, out) {
  out = ""
  while ((at = index(text, needle)) > 0) {
    out = out substr(text, 1, at - 1) value
    text = substr(text, at + length(needle))
  }
  return out text
}
index($0, "# @@ENV_BINDINGS@@") > 0 {
  while ((getline line < bindings) > 0) print line
  close(bindings)
  next
}
{
  print replace(replace($0, "@@LISTEN@@", listen), "@@DATA_DIR@@", dir)
}
' "$APP_DIR/config.capnp.template" > "$APP_DIR/config.capnp"

rm -f "$names_file" "$bindings_file"
trap - 0
exec "$WORKERD_BIN" serve "$APP_DIR/config.capnp"
