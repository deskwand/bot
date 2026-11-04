#!/usr/bin/env bash
# 编译 DeskWand Bot 桌面客户端（.app + .dmg），产物在 desktop/build/<平台>/。
# 用法：npm run build:desktop    或    bash scripts/build-desktop.sh
#
# 构建会先用发布签名私钥生成并签名 Worker 发布包，再嵌入桌面客户端。
# 私钥默认位于 $HOME/.deskwand-bot/release-signing-key.pem；可用
# DESKWAND_RELEASE_SIGNING_KEY_FILE 指定其他路径。私钥不会进入仓库或产物。
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
frontend="$root/desktop/frontend"
key_file="${DESKWAND_RELEASE_SIGNING_KEY_FILE:-$HOME/.deskwand-bot/release-signing-key.pem}"
# shellcheck source=scripts/lib/worker-bundle.sh
source "$root/scripts/lib/worker-bundle.sh"
cleanup_worker_bundle_on_error "$root/desktop/internal/release/bundle"
# 可被直接升级的最低版本。0.1.0 是首个对外发布版本，所以默认就是它；只有某个
# 版本要求必须先经过一个中间版本（例如引入了不可跳过的迁移）时，才临时提高它。
# 它必须不高于本次构建的版本号，构建脚本会拒绝更高的值。
min_from_version="${DESKWAND_MIN_FROM_VERSION:-0.1.0}"

for cmd in go node npm; do
  command -v "$cmd" >/dev/null || { echo "缺少 ${cmd}，请先安装" >&2; exit 1; }
done

if [ ! -f "$key_file" ]; then
  echo "缺少发布签名私钥：$key_file" >&2
  echo "请先运行 npm run generate:release-key 生成密钥，或设置 DESKWAND_RELEASE_SIGNING_KEY_FILE 指向已有私钥。" >&2
  exit 1
fi

version="$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version)' "$root/desktop/mygo.json")"
if [ -z "$version" ]; then
  echo "无法从 desktop/mygo.json 读取版本号" >&2
  exit 1
fi

# 依赖缺失或 lock 文件比已安装依赖新时，按 lock 文件重新安装。
if [ ! -d "$frontend/node_modules" ] || [ "$frontend/package-lock.json" -nt "$frontend/node_modules/.package-lock.json" ]; then
  echo "==> 安装前端依赖"
  npm --prefix "$frontend" ci
fi

prepare_worker_bundle "$root" "$version" "$key_file" "$min_from_version"

echo "==> 编译桌面客户端"
rm -rf "$root/desktop/build"
npm --prefix "$frontend" run build:app

echo
echo "==> 编译完成，产物："
find "$root/desktop/build" -maxdepth 2 \( -name '*.app' -o -name '*.dmg' -o -name '*.exe' \) -print
