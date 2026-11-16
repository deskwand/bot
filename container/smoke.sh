#!/bin/sh
# Smoke-tests a bot image: health, artifact write/read, restart persistence and
# a non-root runtime. With a second argument it also round-trips a file through
# the sandbox image. Usage: sh container/smoke.sh <bot-image> [sandbox-image]
set -eu

image=${1:?usage: sh container/smoke.sh <bot-image> [sandbox-image]}
sandbox=${2:-}
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
  # Set only when the sandbox half of this script runs.
  [ -z "${sandbox_container:-}" ] || docker rm -f "$sandbox_container" >/dev/null 2>&1 || true
  [ -z "${sandbox_dir:-}" ] || rm -rf "$sandbox_dir"
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

if [ -n "$sandbox" ]; then
  sandbox_container="deskwand-smoke-sandbox-$$"
  sandbox_dir=$(mktemp -d)
  docker run --rm -d --name "$sandbox_container" -p 127.0.0.1:18080:8080 \
    -e SANDBOX_TOKEN=smoke-token -v "$sandbox_dir:/sandbox" "$sandbox" >/dev/null
  ready=0
  i=0
  while [ "$i" -lt 30 ]; do
    if curl -s --noproxy '*' -fsS -H "Authorization: Bearer smoke-token" \
      http://127.0.0.1:18080/healthz >/dev/null 2>&1; then
      ready=1
      break
    fi
    i=$((i + 1))
    sleep 1
  done
  [ "$ready" = 1 ] || fail "沙箱没有在 30 秒内起来"

  printf 'binary payload' > "$sandbox_dir/payload.txt"
  curl -s --noproxy '*' -fsS -H "Authorization: Bearer smoke-token" -X PUT \
    --data-binary @"$sandbox_dir/payload.txt" \
    "http://127.0.0.1:18080/files?path=%2Fsandbox%2Froundtrip.txt" >/dev/null
  got=$(curl -s --noproxy '*' -fsS -H "Authorization: Bearer smoke-token" \
    "http://127.0.0.1:18080/files?path=%2Fsandbox%2Froundtrip.txt")
  [ "$got" = "binary payload" ] || fail "沙箱往返内容不一致"

  # The browser must really render: a stub PNG is the failure this pins down.
  # The page is served over http rather than file://: the endpoint only accepts
  # http(s), and smoke should exercise what the product actually allows.
  printf '<!doctype html><meta charset="utf-8"><h1>冒烟 smoke</h1><button>确认</button>' \
    > "$sandbox_dir/probe.html"
  curl -s --noproxy '*' -fsS -H "Authorization: Bearer smoke-token" -X POST \
    -H 'content-type: application/json' \
    --data '{"command":"cd /sandbox && (python3 -m http.server 8099 >/dev/null 2>&1 &)","timeoutMs":5000}' \
    http://127.0.0.1:18080/exec >/dev/null || fail "启不了探针页面服务"
  sleep 1

  curl -s --noproxy '*' -fsS -H "Authorization: Bearer smoke-token" -X POST \
    -H 'content-type: application/json' \
    --data '{"session":"smoke","url":"http://127.0.0.1:8099/probe.html"}' \
    http://127.0.0.1:18080/browser/open >/dev/null || fail "浏览器打不开本地页面"

  curl -s --noproxy '*' -fsS -H "Authorization: Bearer smoke-token" -X POST \
    -H 'content-type: application/json' --data '{"session":"smoke"}' \
    http://127.0.0.1:18080/browser/shot > "$sandbox_dir/shot.png" || fail "截图失败"

  size=$(wc -c < "$sandbox_dir/shot.png" | tr -d ' ')
  [ "$size" -gt 4000 ] || fail "截图只有 $size 字节，不像是真的渲染结果"
  magic=$(od -An -tx1 -N8 "$sandbox_dir/shot.png" | tr -d ' \n')
  [ "$magic" = "89504e470d0a1a0a" ] || fail "截图不是 PNG（前 8 字节 $magic）"

  # The browser must not announce itself as a headless shell: UA and
  # navigator.webdriver are the two tells a site checks before it decides to
  # show a challenge. The page puts all three values in document.title, so the
  # snapshot's own title is the assertion point.
  printf '<!doctype html><meta charset="utf-8"><script>document.title=[navigator.webdriver,navigator.userAgent,navigator.language].join(" | ")</script>' \
    > "$sandbox_dir/ident.html"
  curl -s --noproxy '*' -fsS -H "Authorization: Bearer smoke-token" -X POST \
    -H 'content-type: application/json' \
    --data '{"session":"ident","url":"http://127.0.0.1:8099/ident.html"}' \
    http://127.0.0.1:18080/browser/open > "$sandbox_dir/ident.json" || fail "身份页打不开"
  title=$(sed -n 's/.*"title":"\([^"]*\)".*/\1/p' "$sandbox_dir/ident.json")
  case "$title" in
    true*) fail "navigator.webdriver 仍是 true（title=$title）" ;;
  esac
  case "$title" in
    *HeadlessChrome*) fail "UA 还写着 HeadlessChrome（title=$title）" ;;
  esac

  # `sec-ch-ua` is generated by the network stack, so a page cannot read it: the
  # only honest check is to ask a server what header actually arrived.
  printf 'import {createServer} from "node:http";\ncreateServer((req,res)=>{res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({ua:req.headers["user-agent"]||"",ch:req.headers["sec-ch-ua"]||""}))}).listen(8098,"127.0.0.1");\n' \
    > "$sandbox_dir/echo.mjs"
  curl -s --noproxy '*' -fsS -H "Authorization: Bearer smoke-token" -X PUT \
    --data-binary @"$sandbox_dir/echo.mjs" \
    "http://127.0.0.1:18080/files?path=%2Fsandbox%2Fecho.mjs" >/dev/null
  curl -s --noproxy '*' -fsS -H "Authorization: Bearer smoke-token" -X POST \
    -H 'content-type: application/json' \
    --data '{"command":"cd /sandbox && (node /sandbox/echo.mjs >/dev/null 2>&1 &) && (sleep 1)","timeoutMs":8000}' \
    http://127.0.0.1:18080/exec >/dev/null || fail "启不了请求头回显服务"

  printf '<!doctype html><meta charset="utf-8"><script>fetch("http://127.0.0.1:8098/h").then(r=>r.json()).then(b=>{document.title="ch="+b.ch+" ua="+b.ua})</script>' \
    > "$sandbox_dir/headers.html"
  curl -s --noproxy '*' -fsS -H "Authorization: Bearer smoke-token" -X POST \
    -H 'content-type: application/json' \
    --data '{"session":"headers","url":"http://127.0.0.1:8099/headers.html"}' \
    http://127.0.0.1:18080/browser/open >/dev/null
  sleep 2
  curl -s --noproxy '*' -fsS -H "Authorization: Bearer smoke-token" -X POST \
    -H 'content-type: application/json' --data '{"session":"headers","action":"read"}' \
    http://127.0.0.1:18080/browser/act > "$sandbox_dir/headers.json" || fail "读不到请求头页"
  case "$(sed -n 's/.*"title":"\([^"]*\)".*/\1/p' "$sandbox_dir/headers.json")" in
    *HeadlessChrome*) fail "sec-ch-ua 或 UA 仍然带着 HeadlessChrome" ;;
  esac

  # The takeover stream must produce a real JPEG frame quickly.
  curl -s --noproxy '*' -fsS -H "Authorization: Bearer smoke-token" -X POST \
    -H 'content-type: application/json' \
    --data '{"url":"http://127.0.0.1:8099/probe.html"}' \
    http://127.0.0.1:18080/browser/mirror/open >/dev/null || fail "接管打不开页面"
  # macOS has no `timeout`; curl's own --max-time ends the read.
  curl -s --noproxy '*' --max-time 8 -N -H "Authorization: Bearer smoke-token" \
    http://127.0.0.1:18080/browser/mirror | head -c 200000 > "$sandbox_dir/frames.txt" || true
  grep -q '^event: frame' "$sandbox_dir/frames.txt" || fail "接管流 8 秒内没有出帧"
  grep -q '"jpeg":"/9j/' "$sandbox_dir/frames.txt" || fail "帧不是 JPEG（base64 前缀不是 /9j/）"
  curl -s --noproxy '*' -fsS -H "Authorization: Bearer smoke-token" -X POST \
    -H 'content-type: application/json' --data '{}' \
    http://127.0.0.1:18080/browser/mirror/close >/dev/null
fi

echo "smoke ok"
