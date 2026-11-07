#!/usr/bin/env bash
# 编译 DeskWand Bot 桌面客户端，产物在 desktop/build/<平台>/。
# 用法：npm run build:desktop                       # 默认 macOS
#       npm run build:desktop -- --platform windows # 交叉构建 Windows amd64
#       或    bash scripts/build-desktop.sh [--platform macos|windows]
#
# 构建会先用发布签名私钥生成并签名 Worker 发布包，再嵌入桌面客户端。
# 私钥默认位于 $HOME/.deskwand-bot/release-signing-key.pem；可用
# DESKWAND_RELEASE_SIGNING_KEY_FILE 指定其他路径。私钥不会进入仓库或产物。
#
# Windows 目标还要用客户端更新私钥生成 update-windows-amd64.json：默认读
# $HOME/.deskwand-bot/client-update.key，可用 DESKWAND_CLIENT_UPDATE_KEY_FILE 覆盖。
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
frontend="$root/desktop/frontend"

# 维护者的真实发布配置（gitignored）。没有这个文件时就按提交的占位符构建，
# 这是开源检出的预期行为。
if [ -f "$root/.release.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$root/.release.env"
  set +a
fi

# 更新配置只在维护者机器上有值；构建结束（不管成功还是失败）一律还原。
merge_config() { node --experimental-strip-types "$root/scripts/lib/mygo-release-config.ts" merge; }
restore_config() { node --experimental-strip-types "$root/scripts/lib/mygo-release-config.ts" restore || true; }
# release-desktop.sh 会在整个发布过程中（包括它自己的上传步骤）持有合并结果，
# 由它负责合并与还原。这里再合并一次会把备份写成已合并的内容，退出时就还原不回
# 提交里的占位符了。
if [ "${DESKWAND_RELEASE_CONFIG_MERGED:-}" = "1" ]; then
  echo "==> 沿用 release-desktop.sh 已合并的发布配置"
else
  merge_config
  trap restore_config EXIT
fi

# 遥测地址不进仓库：官方构建用 -X 注入，没配置时留空，客户端不上报。
if [ -n "${DESKWAND_TELEMETRY_BASE:-}" ]; then
  export MYGO_LDFLAGS="-X main.telemetryBaseURL=${DESKWAND_TELEMETRY_BASE}"
fi
key_file="${DESKWAND_RELEASE_SIGNING_KEY_FILE:-$HOME/.deskwand-bot/release-signing-key.pem}"
client_key_file="${DESKWAND_CLIENT_UPDATE_KEY_FILE:-$HOME/.deskwand-bot/client-update.key}"
# shellcheck source=scripts/lib/worker-bundle.sh
source "$root/scripts/lib/worker-bundle.sh"
cleanup_worker_bundle_on_error "$root/desktop/internal/release/bundle"
# 可被直接升级的最低版本。0.1.0 是首个对外发布版本，所以默认就是它；只有某个
# 版本要求必须先经过一个中间版本（例如引入了不可跳过的迁移）时，才临时提高它。
# 它必须不高于本次构建的版本号，构建脚本会拒绝更高的值。
min_from_version="${DESKWAND_MIN_FROM_VERSION:-0.1.0}"

usage() {
  cat >&2 <<'EOF'
用法：build-desktop.sh [--platform macos|windows]

  --platform macos    默认值，构建 .app 与 .dmg
  --platform windows  交叉构建 Windows amd64 可执行文件、NSIS 安装器与更新归档
EOF
}

platform="macos"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --platform)
      [ "$#" -ge 2 ] || { usage; exit 1; }
      platform="$2"
      shift 2
      ;;
    --platform=*)
      platform="${1#--platform=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数：$1" >&2
      usage
      exit 1
      ;;
  esac
done

case "$platform" in
  macos|windows) ;;
  *)
    echo "不支持的平台：$platform（只支持 macos、windows）" >&2
    usage
    exit 1
    ;;
esac

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

if [ "$platform" = "windows" ]; then
  # Windows 宿主上 MyGo 会自行下载或使用已安装的 NSIS；只有交叉构建才要求
  # 本机 PATH 里有 makensis。
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) ;;
    *)
      command -v makensis >/dev/null || {
        echo "缺少 makensis（NSIS），无法生成 Windows 安装器" >&2
        echo "macOS 上可用 brew install makensis 安装；没有安装器时 MyGo 会跳过 .exe 产物。" >&2
        exit 1
      }
      ;;
  esac
  if [ ! -f "$client_key_file" ]; then
    echo "缺少客户端更新私钥：$client_key_file" >&2
    echo "没有它 MyGo 不会生成 update-windows-amd64.json；可设置 DESKWAND_CLIENT_UPDATE_KEY_FILE 指向已有私钥。" >&2
    exit 1
  fi
fi

# 依赖缺失或 lock 文件比已安装依赖新时，按 lock 文件重新安装。
if [ ! -d "$frontend/node_modules" ] || [ "$frontend/package-lock.json" -nt "$frontend/node_modules/.package-lock.json" ]; then
  echo "==> 安装前端依赖"
  npm --prefix "$frontend" ci
fi

prepare_worker_bundle "$root" "$version" "$key_file" "$min_from_version"

case "$platform" in
  macos)
    echo "==> 编译桌面客户端"
    # 只清理本平台目录与共享校验和：同一工作区里可能刚构建过 windows 产物，
    # 发布流程需要两者共存到各自上传完成。
    rm -rf "$root/desktop/build/darwin-arm64" "$root/desktop/build/SHA256SUMS"
    npm --prefix "$frontend" run build:app

    echo
    echo "==> 编译完成，产物："
    find "$root/desktop/build" -maxdepth 2 \( -name '*.app' -o -name '*.dmg' -o -name '*.exe' \) -print
    ;;
  windows)
    echo "==> 编译桌面客户端（windows/amd64）"
    rm -rf "$root/desktop/build/windows-amd64" "$root/desktop/build/SHA256SUMS"
    npm --prefix "$frontend" run generate
    npm --prefix "$frontend" run build

    # 只给 windows 构建的子进程设 UTF-8 locale：NSIS 3.12 在 C locale
    # （LC_ALL=C 或 LANG=""）下 makensis 会因 std::bad_alloc 崩溃，交叉构建因此
    # 拿不到安装器。macOS 打包不经过 makensis，不需要这一项。
    # MYGO_UPDATER_PRIVATE_KEY 同样只在这个子 shell 里可见，不进入前端构建环境。
    (
      export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
      export MYGO_UPDATER_PRIVATE_KEY="$(cat "$client_key_file")"
      cd "$frontend"
      npx mygo build -skip-build-command -platform windows/amd64 ..
    )

    windows_dir="$root/desktop/build/windows-amd64"
    missing=false
    for artifact in \
      "$windows_dir/deskwand-bot-${version}-windows-amd64.tar.gz" \
      "$windows_dir/update-windows-amd64.json" \
      "$windows_dir/deskwand-bot-setup-${version}-amd64.exe" \
      "$root/desktop/build/SHA256SUMS"; do
      if [ ! -f "$artifact" ]; then
        echo "构建产物缺失：$artifact" >&2
        missing=true
      fi
    done
    [ "$missing" = false ] || exit 1

    echo
    echo "==> 编译完成，产物："
    find "$windows_dir" -maxdepth 1 -type f -print
    echo "$root/desktop/build/SHA256SUMS"
    ;;
esac
