#!/bin/bash
# Updates this node to the latest code of the backend's branch (macOS and
# Linux; update.ps1 on Windows). Uses the node's own token (not the node key):
# turning the node off on the backend also stops its updates.
#
#   bash update.sh [--force]
#
# Stops the node (running tasks are handed back to the queue), swaps in the new
# code, installs the packages and builds. If that fails the old code is put
# back and the node is started again. The data folder (config, models, repos)
# is outside the code folder and is never touched.

main() {
  set -euo pipefail
  local root force=0 tmp sha current inner cli
  root="$(cd "$(dirname "$0")" && pwd)"
  . "$root/node-lib.sh"
  [ "${1:-}" != --force ] || force=1
  [ "$(id -u)" -ne 0 ] || die "run it as the user that runs the node, without sudo"
  command -v unzip > /dev/null || die "unzip is needed"
  cli=(node "$root/apps/node/dist/cli.js")

  tmp=$(mktemp -d "${TMPDIR:-/tmp}/gab-ai-node-update.XXXXXX")
  trap 'rm -rf "'"$tmp"'"' EXIT

  step "Latest version"
  "${cli[@]}" fetch version "$tmp/version.json" || die "could not ask the backend (is this node turned off, or Tailscale down?)"
  sha=$(sed -n 's/.*"sha":"\([0-9a-f]\{40\}\)".*/\1/p' "$tmp/version.json" | head -n 1)
  [ -n "$sha" ] || die "the backend's answer has no version"
  current=$(cat "$root/.version" 2> /dev/null || echo none)
  echo "installed ${current:0:7}, latest ${sha:0:7}"
  if [ "$sha" = "$current" ] && [ "$force" = 0 ]; then
    echo "up to date (bash update.sh --force to reinstall)"
    return 0
  fi

  step "Download"
  "${cli[@]}" fetch code "$tmp/code.zip" "$sha" || die "download failed"
  unzip -q "$tmp/code.zip" -d "$tmp/x" || die "the download is not a valid zip"
  inner=$(find "$tmp/x" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  [ "$(find "$tmp/x" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" = 1 ] && [ -f "$inner/setup.sh" ] \
    || die "the download does not look like the node code (no setup.sh)"

  step "Swap"
  local old="$root.old"
  [ ! -e "$old" ] || die "$old exists (an earlier update stopped halfway): check it, then remove it"
  stop_service
  mv "$root" "$old"
  mv "$inner" "$root"
  echo "$sha" > "$root/.version"
  if ! (cd "$root" && npm ci --no-audit --no-fund && npm run build); then
    warn "the new code did not install or build: putting the old code back"
    rm -rf "$root"
    mv "$old" "$root"
    start_service
    die "update failed, still on ${current:0:7}"
  fi
  rm -rf "$old"
  start_service
  echo "updated to ${sha:0:7}; the node runs again"
}

main "$@"
