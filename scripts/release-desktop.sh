#!/usr/bin/env bash
# 构建并发布桌面客户端更新到 R2（my-update-assets/bot）。
#
# 用法：npm run release:desktop [-- --dry-run] [-- --platform macos|windows|both]
#       或    bash scripts/release-desktop.sh [--dry-run] [--platform macos|windows|both]
#
# --platform 默认按宿主平台（macOS 上是 macos，Windows 上是 windows）；both 表示
# 先 macOS 后 Windows。两个平台严格顺序执行、不并发：mygo 上传 SHA256SUMS 前会
# 读取线上文件再合并，并发会互相覆盖。
#
# --dry-run 只打印步骤和将要上传的文件，不检查密钥、不联网、不构建、不上传。
# 真正发布会写入 R2：上传前完成全部本地与线上校验，上传后核验公网 manifest
# 与归档。脚本从不删除 R2 上的任何对象。
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
frontend="$root/desktop/frontend"

# 维护者的真实发布配置（gitignored）。没有它时基址就是占位符，真发布会拒绝。
if [ -f "$root/.release.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$root/.release.env"
  set +a
fi

release_key_file="${DESKWAND_RELEASE_SIGNING_KEY_FILE:-$HOME/.deskwand-bot/release-signing-key.pem}"
client_key_file="${DESKWAND_CLIENT_UPDATE_KEY_FILE:-$HOME/.deskwand-bot/client-update.key}"

usage() {
  cat >&2 <<'EOF'
用法：release-desktop.sh [--dry-run] [--platform macos|windows|both]

  --dry-run   只打印发布步骤，不联网、不读凭据、不构建、不上传
  --platform  发布目标，默认按宿主平台（macOS = macos）；both 先 macOS 后 Windows
EOF
}

dry_run=false
platform=""
platform_set=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      dry_run=true
      shift
      ;;
    --platform)
      [ "$#" -ge 2 ] || { usage; exit 1; }
      platform="$2"
      platform_set=true
      shift 2
      ;;
    --platform=*)
      platform="${1#--platform=}"
      platform_set=true
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

# 宿主平台 -> 默认发布目标。Windows 只发 amd64，没有 arm64。
host_platform() {
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) echo "macos" ;;
    MINGW*-x86_64|MSYS*-x86_64|CYGWIN*-x86_64) echo "windows" ;;
    *) return 1 ;;
  esac
}

if [ "$platform_set" = true ] && [ -z "$platform" ]; then
  echo "--platform 需要一个非空值：macos、windows 或 both" >&2
  usage
  exit 1
fi

if [ -z "$platform" ]; then
  platform="$(host_platform)" || {
    echo "无法从 $(uname -s)-$(uname -m) 推导发布平台，请显式传 --platform macos|windows|both" >&2
    exit 1
  }
fi

case "$platform" in
  macos|windows) targets=("$platform") ;;
  both) targets=(macos windows) ;;
  *)
    echo "不支持的平台：$platform（只支持 macos、windows、both）" >&2
    usage
    exit 1
    ;;
esac

# target 名与 mygo 的 -platform 取值。
target_of() {
  case "$1" in
    macos) echo "darwin-arm64" ;;
    windows) echo "windows-amd64" ;;
  esac
}
mygo_platform_of() {
  case "$1" in
    macos) echo "darwin/arm64" ;;
    windows) echo "windows/amd64" ;;
  esac
}
build_dir_of() {
  echo "$root/desktop/build/$(target_of "$1")"
}

if ! command -v node >/dev/null; then
  echo "缺少 node，请先安装" >&2
  exit 1
fi

version="$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version)' "$root/desktop/mygo.json")"
if [ -z "$version" ]; then
  echo "无法从 desktop/mygo.json 读取版本号" >&2
  exit 1
fi

slug="deskwand-bot"
default_base="https://updates.example.com/bot"
# 与 scripts/desktop-release.ts 的 updateBase 逐字一致：trim()、空值回落到默认值、
# 再去掉全部尾部斜杠。用 node 做，避免 shell 的空白判断与 TS 的 trim() 不一致。
base="$(DESKWAND_UPDATE_BASE="${DESKWAND_UPDATE_BASE-}" node -e '
const raw = (process.env.DESKWAND_UPDATE_BASE ?? "").trim();
process.stdout.write((raw || process.argv[1]).replace(/\/+$/, ""));
' "$default_base")"

# 把指向占位符的客户端发出去等于让所有人失去更新通道，所以真发布一律拒绝。
# --dry-run 不联网、不上传，保留它以便在没有 .release.env 的机器上预览步骤。
if [ "$dry_run" != true ]; then
  case "$base" in
    *example.com*)
      echo "更新基址仍是占位符（$base）：请在 .release.env 里设置 DESKWAND_UPDATE_BASE。" >&2
      exit 1
      ;;
  esac
fi

# 每个目标自己的归档、安装包与安装脚本名。
files_of() {
  local t="$1"
  case "$t" in
    darwin-arm64)
      archive="${slug}-${version}-${t}.tar.gz"
      installer="${slug}-${version}-arm64.dmg"
      install_script="install.sh"
      ;;
    windows-amd64)
      archive="${slug}-${version}-${t}.tar.gz"
      installer="${slug}-setup-${version}-amd64.exe"
      install_script="install.ps1"
      ;;
  esac
}

if [ "$dry_run" = true ]; then
  echo "==> 发布 ${version}（平台：${platform}，dry-run：不构建、不联网、不读密钥、不上传）"
  echo
  echo "目标顺序：${targets[*]}（严格顺序，不并发）"
  echo
  echo "1. 前置检查：git 工作区干净；Worker 发布私钥 ${release_key_file}；客户端更新私钥 ${client_key_file}"
  echo "2. desktop-release.ts preflight ${version}（三处版本一致、CHANGELOG 含该版本）"
  echo "3. 逐目标线上版本检查（只有 404 视为该平台首发）："
  for target in "${targets[@]}"; do
    printf '   %-8s GET %s/update-%s.json\n' "$target" "$base" "$(target_of "$target")"
  done
  echo "4. 逐目标生成并签名 Worker 发布包、嵌入客户端并打包本平台产物："
  for target in "${targets[@]}"; do
    printf '   %-8s bash scripts/build-desktop.sh --platform %s → desktop/build/%s/\n' \
      "$target" "$target" "$(target_of "$target")"
  done
  echo "5. 从 ~/.mc/config.json 的 aliases.r2 读取 R2 凭据（不打印、不写盘），逐目标上传："
  for target in "${targets[@]}"; do
    t="$(target_of "$target")"
    files_of "$t"
    echo "   ${target} → ${t}"
    echo "     上传：${installer}、${archive}、${slug}-<from>-to-${version}-${t}.delta（仅当存在上一版本）、"
    echo "           ${install_script}、SHA256SUMS（合并后）、update-${t}.json（最后上传）"
    echo "     命令：cd desktop/frontend && npx mygo build -skip-build-command -platform $(mygo_platform_of "$target") -upload .."
    if [ "$target" = "windows" ]; then
      echo "     额外：MYGO_UPDATER_PRIVATE_KEY 与 LANG/LC_ALL=en_US.UTF-8（NSIS 需要 UTF-8 locale）"
    fi
  done
  echo "6. 逐目标公网核验：manifest 的版本；归档、安装包、安装脚本的大小与 SHA-256 对公网 SHA256SUMS 逐字节核对"
  if [ "$platform" = "both" ]; then
    echo "   windows 的核验额外带上 darwin-arm64，确认共享 SHA256SUMS 仍保留 macOS 行"
  fi
  echo
  echo "本命令只打印，以下动作一行都不跑：构建、读取私钥或 R2 凭据、联网、上传。"
  exit 0
fi

for cmd in git go node npm; do
  command -v "$cmd" >/dev/null || { echo "缺少 ${cmd}，请先安装" >&2; exit 1; }
done

# macOS 产物只能在 macOS arm64 上构建；Windows 允许在 macOS 上交叉构建。
if printf '%s\n' "${targets[@]}" | grep -qx macos; then
  if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
    echo "macOS 产物只能在 macOS arm64 上构建（当前 $(uname -s) $(uname -m)）" >&2
    exit 1
  fi
fi

echo "==> 1/7 前置检查"
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

echo "==> 2/7 发布预检与线上版本检查"
node --experimental-strip-types "$root/scripts/desktop-release.ts" preflight "$version"
# 公网 manifest 的读取会偶发 fetch failed（本机实测），失败即中止发布会让人误以为
# 版本冲突。这里只对网络读取重试 3 次；版本冲突等确定性错误仍会连续失败并中止。
for target in "${targets[@]}"; do
  t="$(target_of "$target")"
  attempt=1
  until node --experimental-strip-types "$root/scripts/desktop-release.ts" check-remote "$t" "$version"; do
    if [ "$attempt" -ge 3 ]; then
      echo "读取 ${t} 的公网 manifest 连续失败 3 次，停止发布" >&2
      exit 1
    fi
    attempt=$((attempt + 1))
    echo "重试 ${t} 的公网 manifest 检查（第 ${attempt} 次）" >&2
    sleep 2
  done
done

echo "==> 3/7 逐平台构建产物"
# build-desktop.sh 自己生成并签名 Worker 发布包、嵌入客户端，再打包本平台产物。
for target in "${targets[@]}"; do
  bash "$root/scripts/build-desktop.sh" --platform "$target"
done

echo "==> 4/7 读取 R2 凭据"
# R2 凭据只存在于脚本内存与上传子 shell 的环境里，不打印、不写文件。
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
aws_key_id="$(printf '%s\n' "$r2_credentials" | sed -n '1p')"
aws_secret="$(printf '%s\n' "$r2_credentials" | sed -n '2p')"
unset r2_credentials

echo "==> 5/7 逐平台上传到 R2"
for target in "${targets[@]}"; do
  t="$(target_of "$target")"
  files_of "$t"
  echo "--> ${t}：${installer}、${archive}、${install_script}、SHA256SUMS、update-${t}.json"
  # 凭据与更新私钥只存在于这个子 shell 的环境里。
  (
    export AWS_ACCESS_KEY_ID="$aws_key_id" AWS_SECRET_ACCESS_KEY="$aws_secret" AWS_REGION=auto
    export MYGO_UPDATER_PRIVATE_KEY="$(cat "$client_key_file")"
    if [ "$target" = "windows" ]; then
      # NSIS 在 C locale（LC_ALL=C / LANG=""）下会 std::bad_alloc 崩溃。
      export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
    fi
    unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy
    export NO_PROXY='*'

    cd "$frontend"
    npx mygo build -skip-build-command -platform "$(mygo_platform_of "$target")" -upload ..
  )
done

echo "==> 6/7 公网核验"
for target in "${targets[@]}"; do
  t="$(target_of "$target")"
  if [ "$t" = "windows-amd64" ] && [ "$platform" = "both" ]; then
    node --experimental-strip-types "$root/scripts/desktop-release.ts" verify \
      "$t" "$version" "$(build_dir_of "$target")" darwin-arm64
  else
    node --experimental-strip-types "$root/scripts/desktop-release.ts" verify \
      "$t" "$version" "$(build_dir_of "$target")"
  fi
done

echo "==> 7/7 完成"
for target in "${targets[@]}"; do
  t="$(target_of "$target")"
  files_of "$t"
  echo "已发布 ${version}（${t}）：${base}/update-${t}.json"
  if [ "$target" = "macos" ]; then
    echo "首次带更新器的版本需要用户手动安装 dmg：${base}/${installer}"
  fi
done
echo "只发布了一个平台时，另一个平台用 --platform <macos|windows> 单独重跑；不得重建同版本覆盖。"
