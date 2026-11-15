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
sandbox_file=$(mktemp)
trap 'rm -f "$names_file" "$bindings_file" "$sandbox_file"' EXIT

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

# The sandbox is a private address on this compose network, so global fetch()
# cannot reach it: "internet" only allows public addresses. A dedicated
# `external` service gets there instead, and it only exists when SANDBOX_URL
# names a plain http host:port. Anything unparseable keeps today's behaviour
# (no binding, no crash).
sandbox_addr=""
# Trailing or leading spaces are common in a hand-edited .env, and the bot
# trims its own copy of this value; a disagreement here would silently put the
# sandbox back on global fetch.
sandbox_raw=$(printf '%s' "${SANDBOX_URL:-}" | tr -d '[:space:]')
if [ -n "$sandbox_raw" ]; then
  case "$sandbox_raw" in
    http://*) rest=${sandbox_raw#http://} ;;
    *) rest="" ;;
  esac
  if [ -z "$rest" ]; then
    echo "SANDBOX_URL 不是 http://地址，不生成沙箱出站绑定，沙箱将走全局 fetch（内网地址会失败）" >&2
  else
    addr=${rest%%/*}
    addr=${addr%%\?*}
    addr=${addr##*@}
    case "$addr" in
      *:*) host=${addr%:*} ; port=${addr##*:} ;;
      *) host="" ; port="" ;;
    esac
    case "$host" in "" | *[!A-Za-z0-9._-]*) host="" ;; esac
    case "$port" in "" | *[!0-9]*) port="" ;; esac
    if [ -z "$host" ] || [ -z "$port" ]; then
      echo "无法从 SANDBOX_URL 解析 http://主机:端口，不生成沙箱出站绑定，沙箱将走全局 fetch（内网地址会失败）" >&2
    else
      sandbox_addr="${host}:${port}"
    fi
  fi
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

# Both lines or neither: a binding pointing at a service that was not declared
# makes workerd refuse to start. The marker check guards the other side of the
# same failure: a template without the slot cannot host the service.
if [ -n "$sandbox_addr" ]; then
  if grep -q '@@SANDBOX_SERVICE@@' "$APP_DIR/config.capnp.template"; then
    printf '    (name = "SANDBOX", service = "sandbox"),\n' >> "$bindings_file"
    printf '    (name = "sandbox", external = (address = "%s", http = ())),\n' "$sandbox_addr" \
      > "$sandbox_file"
  else
    echo "配置模板缺少 @@SANDBOX_SERVICE@@ 位置，不生成沙箱出站绑定" >&2
  fi
fi

awk -v listen="$LISTEN" -v dir="$DATA_DIR" -v bindings="$bindings_file" -v sbx="$sandbox_file" '
function replace(text, needle, value,    at, out) {
  out = ""
  while ((at = index(text, needle)) > 0) {
    out = out substr(text, 1, at - 1) value
    text = substr(text, at + length(needle))
  }
  return out text
}
index($0, "# @@SANDBOX_SERVICE@@") > 0 {
  while ((getline line < sbx) > 0) print line
  close(sbx)
  next
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

rm -f "$names_file" "$bindings_file" "$sandbox_file"
trap - 0
exec "$WORKERD_BIN" serve "$APP_DIR/config.capnp"
