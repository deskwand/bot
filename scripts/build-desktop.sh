#!/usr/bin/env bash
# 编译 DeskWand Bot 桌面客户端（.app + .dmg），产物在 desktop/build/<平台>/。
# 用法：npm run build:desktop    或    bash scripts/build-desktop.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
frontend="$root/desktop/frontend"

for cmd in go node npm; do
  command -v "$cmd" >/dev/null || { echo "缺少 $cmd，请先安装" >&2; exit 1; }
done

# 依赖缺失或 lock 文件比已安装依赖新时，按 lock 文件重新安装。
if [ ! -d "$frontend/node_modules" ] || [ "$frontend/package-lock.json" -nt "$frontend/node_modules/.package-lock.json" ]; then
  echo "==> 安装前端依赖"
  npm --prefix "$frontend" ci
fi

echo "==> 编译桌面客户端"
rm -rf "$root/desktop/build"
npm --prefix "$frontend" run build:app

echo
echo "==> 编译完成，产物："
find "$root/desktop/build" -maxdepth 2 \( -name '*.app' -o -name '*.dmg' -o -name '*.exe' \) -print
