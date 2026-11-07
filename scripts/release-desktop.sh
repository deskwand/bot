#!/usr/bin/env bash
# 打印桌面客户端的发布步骤，只做 --dry-run。
#
# 用法：bash scripts/release-desktop.sh --dry-run
#       或    npm run release:desktop -- --dry-run
#
# 本脚本按宿主平台推导 target，用 Node 读取 desktop/mygo.json 的版本，然后打印
# 这次发布会用到的 manifest、归档与安装包名。它不构建、不联网、不读取私钥或 R2
# 凭据、不上传，也不能用来发内部测试包：真正的构建与上传只能手动触发
# .github/workflows/desktop-release.yml，由它发布到 R2 的 my-update-assets/bot。
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"

# 只接受恰好一个 --dry-run。其它调用在检查依赖、读取密钥之前就失败。
if [ "$#" -ne 1 ] || [ "$1" != "--dry-run" ]; then
  cat >&2 <<'EOF'
本地脚本只打印发布步骤，不再承担发布。

用法：bash scripts/release-desktop.sh --dry-run

正式发布（构建、上传 R2 my-update-assets/bot、核验公网产物）必须手动触发：
  .github/workflows/desktop-release.yml
EOF
  exit 1
fi

# 打印只需要 node；构建工具链与凭据只在工作流里需要。
if ! command -v node >/dev/null; then
  echo "缺少 node，请先安装" >&2
  exit 1
fi

# 宿主平台 -> 已发布 target。Windows 只发 amd64，没有 arm64。
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) target="darwin-arm64" ;;
  MINGW*-x86_64|MSYS*-x86_64|CYGWIN*-x86_64) target="windows-amd64" ;;
  *) echo "Unsupported host platform" >&2; exit 1 ;;
esac

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

manifest="$base/update-${target}.json"
archive="${slug}-${version}-${target}.tar.gz"
case "$target" in
  darwin-arm64)
    installer="${slug}-${version}-arm64.dmg"
    install_script="install.sh"
    platform_input="macos"
    ;;
  windows-amd64)
    installer="${slug}-setup-${version}-amd64.exe"
    install_script="install.ps1"
    platform_input="windows"
    ;;
esac

cat <<EOF
==> 发布 ${version}（${target}，dry-run：不构建、不联网、不读密钥、不上传）

以下步骤由工作流执行，本命令一行都不跑。

1. 版本检查：desktop/mygo.json、desktop/main.go 的 appVersion、desktop/frontend/package.json
   三处一致，均为 ${version}
2. 线上版本检查：GET ${manifest}（404 视为 ${target} 首发）
3. 构建并签名 Worker 发布包，嵌入客户端后打包出本平台产物
4. 发布产物（工作流上传到 R2 my-update-assets/bot）：
   ${installer}
   ${archive}
   ${slug}-<from>-to-${version}-${target}.delta（仅当存在上一版本）
   ${install_script}
   SHA256SUMS
   update-${target}.json（最后上传）
5. 公网核验：manifest 的 version；归档、${installer}、${install_script} 的大小与 SHA-256，并与公网 SHA256SUMS 的校验和逐字节核对

本命令只打印。真正的构建与上传必须手动触发工作流：
  .github/workflows/desktop-release.yml
  workflow_dispatch：version=${version}，platforms=${platform_input}，mode=publish，confirm=PUBLISH
EOF
