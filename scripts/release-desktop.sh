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

# 合并/还原维护者的发布配置（desktop/mygo.release.json → desktop/mygo.json）。
merge_config() { node --experimental-strip-types "$root/scripts/lib/mygo-release-config.ts" merge; }
restore_config() { node --experimental-strip-types "$root/scripts/lib/mygo-release-config.ts" restore >/dev/null 2>&1 || true; }
# EXIT trap 不会因 SIGTERM/SIGINT 触发，而合并后的 mygo.json 里是真实域名与账号 ID：
# 被打断也要先还原，所以把这两个信号转成一次正常退出。
# 上一次被 SIGKILL 或断电打断时会留下合并态，这里先还原，避免把真值留在工作区。
restore_config >/dev/null 2>&1 || true
trap restore_config EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# 版本发布完成后打 tag 并建 GitHub Release。两个平台的公网 manifest 都到这一版才建
# Release，避免把一个只有单平台可用的版本当成完整发布对外公布。
github_tag_and_release() {
  local tag="v${version}"
  if ! command -v gh >/dev/null; then
    echo "缺少 gh（GitHub CLI），跳过 tag 与 GitHub Release" >&2
    return 0
  fi
  if git -C "$root" rev-parse -q --verify "refs/tags/${tag}" >/dev/null; then
    echo "tag ${tag} 已存在"
  else
    git -C "$root" tag -a "$tag" -m "DeskWand Bot ${version}"
    echo "已创建 tag ${tag}"
  fi
  # git 的网络操作同样会偶发超时（本机实测 SSL connection timeout）：远端查不到就
  # 直接推送，推送本身幂等，失败重试 3 次而不是让整轮发布停在一个已经成功的版本上。
  if [ -z "$(git -C "$root" ls-remote --tags origin "refs/tags/${tag}" 2>/dev/null)" ]; then
    attempt=1
    until git -C "$root" push origin "$tag"; do
      if [ "$attempt" -ge 3 ]; then
        echo "推送 tag ${tag} 连续失败 3 次" >&2
        return 1
      fi
      attempt=$((attempt + 1))
      echo "重试推送 tag ${tag}（第 ${attempt} 次）" >&2
      sleep 2
    done
  fi

  local missing=""
  local t published
  for t in darwin-arm64 windows-amd64; do
    # manifest 的排版由 mygo 决定，所以按 JSON 解析而不是匹配文本。
    published="$(curl -fsS --max-time 30 "${base}/update-${t}.json" 2>/dev/null |
      node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).version))}catch{}})' ||
      true)"
    if [ "$published" != "$version" ]; then
      missing="${missing} ${t}"
    fi
  done
  if [ -n "$missing" ]; then
    echo "尚缺平台：${missing}（tag 已推送）。两个平台的 manifest 都到 ${version} 后，"
    echo "运行 npm run release:desktop -- --github-only 建 GitHub Release。"
    return 0
  fi

  local notes assets=() target dir
  notes="$(mktemp)"
  node --experimental-strip-types "$root/scripts/desktop-release.ts" notes "$version" >"$notes"
  for target in macos windows; do
    files_of "$(target_of "$target")"
    dir="$(build_dir_of "$target")"
    if [ -f "$dir/$installer" ]; then
      assets+=("$dir/$installer")
    else
      echo "缺少本平台安装包 ${installer}：Release 将不带它" >&2
    fi
  done
  [ -f "$root/desktop/build/SHA256SUMS" ] && assets+=("$root/desktop/build/SHA256SUMS")

  if (cd "$root" && gh release view "$tag" >/dev/null 2>&1); then
    echo "GitHub Release ${tag} 已存在"
  else
    (cd "$root" && gh release create "$tag" \
      --title "DeskWand Bot ${version}" \
      --notes-file "$notes" \
      "${assets[@]}")
  fi
  rm -f "$notes"
}

usage() {
  cat >&2 <<'EOF'
用法：release-desktop.sh [--dry-run] [--platform macos|windows|both] [--github-only] [--no-github]

  --dry-run      只打印发布步骤，不联网、不读凭据、不构建、不上传
  --platform     发布目标，默认按宿主平台（macOS = macos）；both 先 macOS 后 Windows
  --github-only  只给已发布的版本打 tag 并建 GitHub Release，不构建、不上传
  --no-github    不发 tag、不建 GitHub Release
EOF
}

dry_run=false
platform=""
platform_set=false
github=true
github_only=false
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
    --github-only)
      github_only=true
      shift
      ;;
    --no-github)
      github=false
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

# target 名（也是 manifest 与归档里的平台名）。
target_of() {
  case "$1" in
    macos) echo "darwin-arm64" ;;
    windows) echo "windows-amd64" ;;
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
  echo "4. 从 ~/.mc/config.json 的 aliases.r2 读取 R2 凭据（不打印、不写盘），逐目标构建并上传："
  for target in "${targets[@]}"; do
    t="$(target_of "$target")"
    files_of "$t"
    echo "   ${target} → ${t}"
    echo "     命令：bash scripts/build-desktop.sh --platform ${target} --upload（一次调用里签名 Worker 发布包、"
    echo "           嵌入客户端、打包并上传，每个平台只构建一次）"
    echo "     上传：${installer}、${archive}、${slug}-<from>-to-${version}-${t}.delta（仅当存在上一版本，最多 updates.deltas 个）、"
    echo "           ${install_script}、SHA256SUMS（合并后）、update-${t}.json（最后上传）"
    if [ "$target" = "windows" ]; then
      echo "     额外：MYGO_UPDATER_PRIVATE_KEY 与 LANG/LC_ALL=en_US.UTF-8（NSIS 需要 UTF-8 locale）"
    fi
  done
  echo "5. 逐目标公网核验：manifest 的版本；归档、安装包、安装脚本的大小与 SHA-256 对公网 SHA256SUMS 逐字节核对"
  if [ "$platform" = "both" ]; then
    echo "   windows 的核验额外带上 darwin-arm64，确认共享 SHA256SUMS 仍保留 macOS 行"
  fi
  echo "6. 打 tag v${version}、推送到 origin，并在两个平台的 manifest 都到该版本后建 GitHub Release"
  echo "   （--no-github 跳过；事后补发用 --github-only）"
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

# --github-only：版本已经在 R2 上，只补 tag 与 GitHub Release。
if [ "$github_only" = true ]; then
  echo "==> 只打 tag 与 GitHub Release（${version}）"
  github_tag_and_release
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
# 公网 manifest 的读取会偶发 fetch failed（本机实测），失败即中止发布会让人误以为
# 版本冲突。这里只对网络读取重试 3 次；版本冲突等确定性错误仍会连续失败并中止。
for target in "${targets[@]}"; do
  t="$(target_of "$target")"
  attempt=1
  until node --experimental-strip-types "$root/scripts/desktop-release.ts" check-remote "$t" "$version"; do
    if [ "$attempt" -ge 5 ]; then
      echo "读取 ${t} 的公网 manifest 连续失败 5 次，停止发布" >&2
      exit 1
    fi
    attempt=$((attempt + 1))
    echo "重试 ${t} 的公网 manifest 检查（第 ${attempt} 次）" >&2
    sleep "$((attempt * 2))"
  done
done

echo "==> 3/6 逐平台构建并上传"
# 每个平台只构建一次：mygo 的 -upload 与打包在同一次调用里完成。以前先构建一遍、
# 上传时再构建一遍，编译、打包、下载旧归档和生成 delta 全都做了两遍。
# 合并维护者的更新配置并保持到脚本退出：上传要读同一份 updates，若只在
# build-desktop.sh 里合并，它退出时会还原成占位符，上传就会去读 updates.example.com。
merge_config
export DESKWAND_RELEASE_CONFIG_MERGED=1

# R2 凭据只存在于脚本内存与构建子 shell 的环境里，不打印、不写文件。
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

for target in "${targets[@]}"; do
  t="$(target_of "$target")"
  files_of "$t"
  echo "--> ${t}：构建并上传 ${installer}、${archive}、${install_script}、SHA256SUMS、update-${t}.json"
  (
    export AWS_ACCESS_KEY_ID="$aws_key_id" AWS_SECRET_ACCESS_KEY="$aws_secret" AWS_REGION=auto
    export MYGO_UPDATER_PRIVATE_KEY="$(cat "$client_key_file")"
    if [ "$target" = "windows" ]; then
      # NSIS 在 C locale（LC_ALL=C / LANG=""）下会 std::bad_alloc 崩溃。
      export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
    fi
    unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy
    export NO_PROXY='*'
    bash "$root/scripts/build-desktop.sh" --platform "$target" --upload
  )
done

echo "==> 4/6 公网核验"
# 刚上传的对象不会立刻在公网上可读（0.1.35 实测：核验第一次读到 404，约半分钟后正常），
# 先等几秒再核验，避免把「还没生效」当成发布失败。
sleep 5
# 核验要下载公网文件，两类瞬时失败都会遇到：fetch failed，以及刚上传的对象还读到 404。
# 核验只读，失败重试 8 次；内容不符这类确定性错误仍会连续失败并中止。
for target in "${targets[@]}"; do
  t="$(target_of "$target")"
  verify_args=("$t" "$version" "$(build_dir_of "$target")")
  if [ "$t" = "windows-amd64" ] && [ "$platform" = "both" ]; then
    verify_args+=("darwin-arm64")
  fi
  attempt=1
  until node --experimental-strip-types "$root/scripts/desktop-release.ts" verify \
    "${verify_args[@]}"; do
    if [ "$attempt" -ge 8 ]; then
      echo "核验 ${t} 连续失败 8 次，停止发布" >&2
      exit 1
    fi
    attempt=$((attempt + 1))
    echo "重试 ${t} 的公网核验（第 ${attempt} 次）" >&2
    # 逐渐拉长到 20 秒，给 CDN 生效留出约两分钟。
    sleep "$((attempt * 5 > 20 ? 20 : attempt * 5))"
  done
done

echo "==> 5/6 完成"
for target in "${targets[@]}"; do
  t="$(target_of "$target")"
  files_of "$t"
  echo "已发布 ${version}（${t}）：${base}/update-${t}.json"
  if [ "$target" = "macos" ]; then
    echo "首次带更新器的版本需要用户手动安装 dmg：${base}/${installer}"
  fi
done
echo "只发布了一个平台时，另一个平台用 --platform <macos|windows> 单独重跑；不得重建同版本覆盖。"


echo "==> 6/6 打 tag 与 GitHub Release"
if [ "$github" = true ]; then
  github_tag_and_release
else
  echo "已指定 --no-github：跳过 tag 与 GitHub Release"
fi
