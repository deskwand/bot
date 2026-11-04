#!/usr/bin/env bash
# Worker 发布包的生成、签名与嵌入，供 build-desktop.sh 和 release-desktop.sh 共用。
# 调用方需先确认 go / node / npm 可用，并自行读取版本号与私钥路径。

# A failed build must not leave a partially populated embedded bundle that a
# later go build could ship.
cleanup_worker_bundle() {
  local bundle="$1"
  if [ -d "$bundle" ]; then
    find "$bundle" -mindepth 1 -maxdepth 1 ! -name '.gitkeep' -exec rm -rf {} + || true
  fi
}

# 安装 ERR trap：失败时清理 <bundle> 里已嵌入的内容。
cleanup_worker_bundle_on_error() {
  WORKER_BUNDLE_DIR="$1"
  trap 'cleanup_worker_bundle "$WORKER_BUNDLE_DIR"' ERR
}

# prepare_worker_bundle <root> <version> <release_key_file> <min_from_version>
prepare_worker_bundle() {
  local root="$1"
  local version="$2"
  local release_key_file="$3"
  local min_from_version="$4"
  local release_dir="$root/dist/worker-release"
  local bundle="$root/desktop/internal/release/bundle"

  # 嵌入之后、打包完成之前的任何失败也要清理 bundle。
  cleanup_worker_bundle_on_error "$bundle"

  echo "==> 生成 Worker 发布包（版本 ${version}）"
  rm -rf "$release_dir"
  (cd "$root" && npm run release:worker -- --version "$version" --key-id deskwand-release-1 --min-from-version "$min_from_version")
  DESKWAND_RELEASE_SIGNING_KEY_FILE="$release_key_file" \
    npm --prefix "$root" run release:sign

  local required
  for required in "$release_dir/manifest.json" "$release_dir/manifest.sig" "$release_dir/modules"; do
    if [ ! -e "$required" ]; then
      echo "Worker 发布包不完整，缺少：$required" >&2
      return 1
    fi
  done

  echo "==> 嵌入 Worker 发布包"
  rm -rf "$bundle/manifest.json" "$bundle/manifest.sig" "$bundle/modules"
  mkdir -p "$bundle"
  cp "$release_dir/manifest.json" "$bundle/manifest.json"
  cp "$release_dir/manifest.sig" "$bundle/manifest.sig"
  cp -R "$release_dir/modules" "$bundle/modules"
}
