#!/usr/bin/env bash
# 构建并发布桌面客户端更新到 R2（my-update-assets/bot）。
#
# 用法：npm run release:desktop [-- --dry-run]    或    bash scripts/release-desktop.sh [--dry-run]
#
# --dry-run 只打印步骤和将要上传的文件，不检查密钥、不联网、不构建、不上传。
# 真正发布会写入 R2：上传前完成全部本地与线上校验，上传后核验公网 manifest
# 与归档。脚本从不删除 R2 上的任何对象。
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
frontend="$root/desktop/frontend"
release_key_file="${DESKWAND_RELEASE_SIGNING_KEY_FILE:-$HOME/.deskwand-bot/release-signing-key.pem}"
client_key_file="${DESKWAND_CLIENT_UPDATE_KEY_FILE:-$HOME/.deskwand-bot/client-update.key}"
# 与 build-desktop.sh 的默认值一致：能直接升级到本版本的最低版本。
min_from_version="${DESKWAND_MIN_FROM_VERSION:-0.1.0}"

dry_run=false
if [ "$#" -gt 1 ]; then
  echo "用法：release-desktop.sh [--dry-run]" >&2
  exit 1
fi
case "${1:-}" in
  "") ;;
  --dry-run) dry_run=true ;;
  *)
    echo "用法：release-desktop.sh [--dry-run]" >&2
    exit 1
    ;;
esac

for cmd in git go node npm; do
  command -v "$cmd" >/dev/null || { echo "缺少 ${cmd}，请先安装" >&2; exit 1; }
done

os="$(uname -s)"
arch="$(uname -m)"
if [ "$os" != "Darwin" ] || [ "$arch" != "arm64" ]; then
  echo "只支持在 macOS arm64 上发布（当前 ${os} ${arch}）" >&2
  exit 1
fi

version="$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version)' "$root/desktop/mygo.json")"
if [ -z "$version" ]; then
  echo "无法从 desktop/mygo.json 读取版本号" >&2
  exit 1
fi

base="${DESKWAND_UPDATE_BASE:-https://updates.example.com/bot}"
base="${base%/}"
manifest="$base/update-darwin-arm64.json"
dmg="deskwand-bot-${version}-arm64.dmg"

if [ "$dry_run" = true ]; then
  cat <<EOF
==> 发布 ${version}（dry-run，不构建、不联网、不写入 R2）

1. 前置检查：git 工作区干净；Worker 发布私钥 ${release_key_file}；客户端更新私钥 ${client_key_file}
2. 版本检查：GET ${manifest}
3. 构建 Worker 发布包、签名并嵌入
4. 构建并上传到 R2 my-update-assets/bot：
   ${dmg}
   deskwand-bot-${version}-darwin-arm64.tar.gz
   deskwand-bot-<from>-to-${version}-darwin-arm64.delta（仅当存在上一版本）
   install.sh
   SHA256SUMS
   update-darwin-arm64.json（最后上传）
5. 公网核验：manifest 的 version、归档大小与 SHA-256
6. 完成
EOF
  exit 0
fi

echo "==> 1/6 前置检查"
if [ -n "$(git -C "$root" status --porcelain)" ]; then
  echo "工作区不干净：请先提交或清理改动再发布" >&2
  exit 1
fi

for key in "$release_key_file" "$client_key_file"; do
  if [ ! -f "$key" ]; then
    echo "缺少私钥：$key" >&2
    exit 1
  fi
done

echo "==> 2/6 发布预检与线上版本检查"
node --experimental-strip-types "$root/scripts/desktop-release.ts" preflight "$version"
node --experimental-strip-types "$root/scripts/desktop-release.ts" check-remote "$manifest" "$version"

# 依赖缺失或 lock 文件比已安装依赖新时，按 lock 文件重新安装。
if [ ! -d "$frontend/node_modules" ] || [ "$frontend/package-lock.json" -nt "$frontend/node_modules/.package-lock.json" ]; then
  echo "==> 安装前端依赖"
  npm --prefix "$frontend" ci
fi

echo "==> 3/6 构建 Worker 发布包"
# shellcheck source=scripts/lib/worker-bundle.sh
source "$root/scripts/lib/worker-bundle.sh"
prepare_worker_bundle "$root" "$version" "$release_key_file" "$min_from_version"
rm -rf "$root/desktop/build"

echo "==> 4/6 构建并上传到 R2"
# 前端构建先于导出凭据执行，tsc/vite 不会看到 R2 凭据或更新私钥。
npm --prefix "$frontend" run build
# R2 凭据只存在于这个子 shell 的环境里，不打印、不写文件。
(
  r2_credentials="$(node -e '
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
let config;
try {
  config = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".mc", "config.json"), "utf8"));
} catch {
  console.error("无法读取 ~/.mc/config.json");
  process.exit(1);
}
const r2 = config.aliases && config.aliases.r2;
if (!r2 || typeof r2.accessKey !== "string" || !r2.accessKey || typeof r2.secretKey !== "string" || !r2.secretKey) {
  console.error("~/.mc/config.json 的 aliases.r2 缺少 accessKey 或 secretKey");
  process.exit(1);
}
process.stdout.write(r2.accessKey + "\n" + r2.secretKey + "\n");
')"
  AWS_ACCESS_KEY_ID="$(printf '%s\n' "$r2_credentials" | sed -n '1p')"
  AWS_SECRET_ACCESS_KEY="$(printf '%s\n' "$r2_credentials" | sed -n '2p')"
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION=auto

  MYGO_UPDATER_PRIVATE_KEY="$(cat "$client_key_file")"
  export MYGO_UPDATER_PRIVATE_KEY

  unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy
  export NO_PROXY='*'

  cd "$frontend"
  npx mygo build -skip-build-command -upload ..
)

echo "==> 5/6 公网核验"
node --experimental-strip-types "$root/scripts/desktop-release.ts" verify \
  "$manifest" "$version" "$root/desktop/build/darwin-arm64"

echo "==> 6/6 完成"
echo "已发布 ${version}：${manifest}"
echo "首次带更新器的版本需要用户手动安装 dmg：${base}/${dmg}"
