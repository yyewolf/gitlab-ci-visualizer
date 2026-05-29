#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

declare -A PLATFORM_BIN=(
  ["linux-x64"]="glvis-linux-amd64"
  ["linux-arm64"]="glvis-linux-arm64"
  ["darwin-x64"]="glvis-darwin-amd64"
  ["darwin-arm64"]="glvis-darwin-arm64"
  ["win32-x64"]="glvis-windows-amd64.exe"
)

# Stash all binaries so we can restore them between iterations and on exit.
tmpdir=$(mktemp -d)
cp bin/* "$tmpdir/" 2>/dev/null || true

cleanup() {
  cp "$tmpdir"/* bin/ 2>/dev/null || true
  rm -rf "$tmpdir"
}
trap cleanup EXIT

for target in "${!PLATFORM_BIN[@]}"; do
  bin="${PLATFORM_BIN[$target]}"

  if [[ ! -f "bin/$bin" ]]; then
    echo "Skipping $target: bin/$bin not found (run 'npm run build-go' first)"
    continue
  fi

  echo "Packaging $target ($bin)..."

  # Remove every binary except the one for this target.
  for f in bin/*; do
    [[ "$(basename "$f")" != "$bin" ]] && rm -f "$f"
  done

  vsce package --target "$target"

  # Restore all binaries before the next iteration.
  cp "$tmpdir"/* bin/ 2>/dev/null || true
done

echo "Done."
