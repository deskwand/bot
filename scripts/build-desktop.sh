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
release_dir="$root/dist/worker-release"
bundle="$root/desktop/internal/release/bundle"
key_file="${DESKWAND_RELEASE_SIGNING_KEY_FILE:-$HOME/.deskwand-bot/release-signing-key.pem}"
# 可被直接升级的最低版本。0.1.0 是首个对外发布版本，所以默认就是它；只有某个
# 版本要求必须先经过一个中间版本（例如引入了不可跳过的迁移）时，才临时提高它。
# 它必须不高于本次构建的版本号，构建脚本会拒绝更高的值。
min_from_version="${DESKWAND_MIN_FROM_VERSION:-0.1.0}"

# A failed build must not leave a partially populated embedded bundle that a
# later go build could ship.
cleanup_bundle_on_error() {
  if [ -d "$bundle" ]; then
    find "$bundle" -mindepth 1 -maxdepth 1 ! -name '.gitkeep' -exec rm -rf {} + || true
  fi
}
trap cleanup_bundle_on_error ERR

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

echo "==> 生成 Worker 发布包（版本 ${version}）"
rm -rf "$release_dir"
(cd "$root" && npm run release:worker -- --version "$version" --key-id deskwand-release-1 --min-from-version "$min_from_version")
DESKWAND_RELEASE_SIGNING_KEY_FILE="$key_file" \
  npm --prefix "$root" run release:sign

for required in "$release_dir/manifest.json" "$release_dir/manifest.sig" "$release_dir/modules"; do
  if [ ! -e "$required" ]; then
    echo "Worker 发布包不完整，缺少：$required" >&2
    exit 1
  fi
done

echo "==> 嵌入 Worker 发布包"
rm -rf "$bundle/manifest.json" "$bundle/manifest.sig" "$bundle/modules"
mkdir -p "$bundle"
cp "$release_dir/manifest.json" "$bundle/manifest.json"
cp "$release_dir/manifest.sig" "$bundle/manifest.sig"
cp -R "$release_dir/modules" "$bundle/modules"

echo "==> 编译桌面客户端"
rm -rf "$root/desktop/build"
npm --prefix "$frontend" run build:app

echo
echo "==> 编译完成，产物："
find "$root/desktop/build" -maxdepth 2 \( -name '*.app' -o -name '*.dmg' -o -name '*.exe' \) -print
