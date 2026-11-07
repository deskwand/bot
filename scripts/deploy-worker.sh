#!/usr/bin/env bash
# 部署 Worker。
#
# 维护者：真实的 PUBLIC_BASE_URL 与 ARTIFACTS 桶名放在仓库根目录的 .release.env
# （gitignored），先生成 wrangler.local.jsonc 再部署。wrangler.jsonc 里的 vars
# 会覆盖云端同名值，bucket_name 又没有 CLI 参数可覆盖，所以两处都靠生成配置解决。
#
# 开源使用者：没有 .release.env 时直接部署提交的 wrangler.jsonc，请先自己把里面的
# PUBLIC_BASE_URL 和 ARTIFACTS 桶名改成真实值。
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
env_file="$root/.release.env"

if [ ! -f "$env_file" ]; then
  echo "未找到 $env_file：按 wrangler.jsonc 里的值部署。" >&2
  echo "如果那里还是占位符，请先改成你自己的 Worker 地址与 R2 桶名。" >&2
  cd "$root"
  exec npx wrangler deploy "$@"
fi

set -a
# shellcheck disable=SC1090
. "$env_file"
set +a

for name in PUBLIC_BASE_URL R2_ARTIFACTS_BUCKET; do
  if [ -z "${!name:-}" ]; then
    echo "缺少 $name：请先在 $env_file 里填写真实值。" >&2
    exit 1
  fi
done
case "$PUBLIC_BASE_URL" in
  *example*|*your-worker*)
    echo "PUBLIC_BASE_URL 仍是占位符（$PUBLIC_BASE_URL），拒绝部署。" >&2
    exit 1
    ;;
esac

cd "$root"
node --experimental-strip-types scripts/lib/wrangler-release-config.ts
exec npx wrangler deploy --config wrangler.local.jsonc "$@"
