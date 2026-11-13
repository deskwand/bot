#!/bin/sh
# Smoke-tests a bot image: health, artifact write/read, restart persistence and
# a non-root runtime. Usage: sh container/smoke.sh <image>
set -eu

image=${1:?usage: sh container/smoke.sh <image>}
root=$(cd "$(dirname "$0")/.." && pwd)

port=18787
token=local-smoke
op=smoke-op
container="deskwand-smoke-$$"
volume="deskwand-smoke-$$"

config=$(sed -n 's/^DESKWAND_CONFIG=//p' "$root/.dev.vars.example")
if [ -z "$config" ]; then
  echo "没有从 .dev.vars.example 读到 DESKWAND_CONFIG" >&2
  exit 1
fi

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo "冒烟失败:$*" >&2
  docker logs "$container" >&2 || true
  exit 1
}

wait_healthy() {
  i=0
  while [ "$i" -lt 60 ]; do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$container" 2>/dev/null || echo missing)
    [ "$status" = "healthy" ] && return 0
    [ "$status" = "unhealthy" ] && return 1
    i=$((i + 1))
    sleep 1
  done
  return 1
}

acquire() {
  curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X POST \
    -H "authorization: Bearer $token" -H 'content-type: application/json' \
    -d "{\"op\":\"export\",\"opId\":\"$op\"}" \
    "http://127.0.0.1:$port/admin/maintenance/acquire"
}

read_key() {
  curl -s --noproxy '*' -H "authorization: Bearer $token" \
    -H "X-Backup-Op: $op" \
    "http://127.0.0.1:$port/admin/r2/object?key=smoke/a.txt"
}

docker volume create "$volume" >/dev/null
docker run -d --name "$container" \
  -p "127.0.0.1:$port:8787" \
  -v "$volume:/data" \
  -e ADMIN_TOKEN="$token" \
  -e MODEL_KEY_OPENCODE_GO=x \
  -e ACTIVE_CHANNEL=telegram \
  -e DESKWAND_CONFIG="$config" \
  "$image" >/dev/null

wait_healthy || fail "容器在 60 秒内没有变成 healthy"

[ "$(acquire)" = "200" ] || fail "无法获取维护租约"

status=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X PUT \
  -H "authorization: Bearer $token" -H "X-Backup-Op: $op" \
  -H 'content-type: text/plain' --data-binary 'hello' \
  "http://127.0.0.1:$port/admin/r2/object?key=smoke/a.txt")
[ "$status" = "204" ] || fail "写入产物返回 $status"

[ "$(read_key)" = "hello" ] || fail "重启前读取产物不是 hello"

docker restart "$container" >/dev/null
wait_healthy || fail "容器重启后没有变成 healthy"

[ "$(acquire)" = "200" ] || fail "重启后无法获取维护租约"
[ "$(read_key)" = "hello" ] || fail "重启后读取产物不是 hello"

uid=$(docker exec "$container" id -u)
[ "$uid" != "0" ] || fail "容器以 root 运行"

echo "smoke ok"
