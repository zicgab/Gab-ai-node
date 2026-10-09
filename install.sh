#!/bin/bash
# Installs a Gab-ai-node agent node on macOS or Linux (install.ps1 on Windows).
# The backend serves this file (gasysteme ai-worker/nodes.js) and writes its own
# address into it (the placeholder below; GAB_NODE_SERVER overrides it). With
# Tailscale connected, in a terminal, as the user that will run the node (not
# with sudo):
#
#   curl -fsSL http://<backend Tailscale IP>:3083/node/agent | bash
#
# Asks for the node key (backend NODE_API_KEY; used to download and register,
# never saved), downloads the latest code into ~/gab-ai-node (another folder:
# export GAB_NODE_DIR first), then runs its setup.sh (packages, build,
# registration, automatic start). Later: bash update.sh in that folder.

main() {
  set -euo pipefail
  local project="agent" server dir key tmp short sha
  die() { printf '\033[31mError: %s\033[0m\n' "$1" >&2; exit 1; }

  case "$(uname -s)" in Darwin | Linux) ;; *) die "this installer is for macOS and Linux (Windows: install.ps1)" ;; esac
  [ "$(id -u)" -ne 0 ] || die "run it as the user that will run the node, without sudo"
  command -v curl > /dev/null || die "curl is needed"
  command -v unzip > /dev/null || die "unzip is needed (Linux: your package manager)"
  local filled='__GAB_NODE_SERVER__'
  server=${GAB_NODE_SERVER:-$filled}
  server=${server%/}
  local url_re='^https?://[^/<>[:space:]]+$'
  [[ $server =~ $url_re ]] || die 'run it from the backend: curl -fsSL http://<backend Tailscale IP>:3083/node/agent | bash'
  dir=${GAB_NODE_DIR:-$HOME/gab-ai-node}
  if [ -f "$dir/.version" ]; then
    # Already there (installed, or setup stopped halfway): offer a clean reinstall, which removes the old node first.
    [ -r /dev/tty ] || die "already installed in $dir. Update: bash update.sh. Setup stopped halfway: cd \"$dir\" && bash setup.sh"
    printf 'Already installed in %s. Remove it and install again? [y/N] ' "$dir" > /dev/tty
    local again
    IFS= read -r again < /dev/tty
    case $again in y | Y | yes) ;; *) die "kept. Update: bash update.sh. Setup stopped halfway: cd \"$dir\" && bash setup.sh (safe to re-run)" ;; esac
    bash "$dir/uninstall.sh" --remove-code < /dev/tty || die "the old node was not removed"
    [ ! -f "$dir/.version" ] || die "the old node is still in $dir (uninstall was cancelled)"
  fi
  if [ -d "$dir" ] && [ -n "$(ls -A "$dir")" ]; then
    die "$dir exists and is not empty. Empty it, or export GAB_NODE_DIR=<another folder>."
  fi
  [ -r /dev/tty ] || die "needs a terminal to ask for the node key"

  printf 'Node key (backend NODE_API_KEY): ' > /dev/tty
  IFS= read -rs key < /dev/tty
  printf '\n' > /dev/tty
  key=$(printf '%s' "$key" | tr -d '[:space:]')
  [ -n "$key" ] || die "no node key given"

  tmp=$(mktemp -d "${TMPDIR:-/tmp}/gab-ai-node-install.XXXXXX")
  trap 'rm -rf "'"$tmp"'"' EXIT

  # json_get <file> <key>: a string field of the backend's flat JSON answers.
  json_get() { sed -n 's/.*"'"$2"'":"\([^"]*\)".*/\1/p' "$1" | head -n 1; }

  # get <path> <outfile> <max seconds>: the key goes to curl through a file
  # descriptor, never on its command line. Fails with the backend's message.
  get() {
    local status message
    status=$(curl -sS -o "$2" -w '%{http_code}' --connect-timeout 15 --max-time "$3" \
      -H @<(printf 'Authorization: Bearer %s\n' "$key") "$server$1") || die "cannot reach $server"
    if [ "$status" != 200 ]; then
      message=$(json_get "$2" message)
      [ -n "$message" ] || message=$(head -c 300 "$2")
      die "the backend refused (HTTP $status): $message"
    fi
  }

  printf '\n\033[36m== Latest version\033[0m\n'
  get "/node/$project/version" "$tmp/version.json" 60
  sha=$(json_get "$tmp/version.json" sha)
  [[ $sha =~ ^[0-9a-f]{40}$ ]] || die "the backend's answer has no version"
  short=${sha:0:7}
  echo "$short ($(json_get "$tmp/version.json" date)): $(json_get "$tmp/version.json" message)"

  printf '\n\033[36m== Download\033[0m\n'
  get "/node/$project/code?ref=$sha" "$tmp/code.zip" 600
  unzip -q "$tmp/code.zip" -d "$tmp/x" || die "the download is not a valid zip"
  # GitHub's zip holds one folder, <owner>-<repo>-<short sha>.
  local inner
  inner=$(find "$tmp/x" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  if [ "$(find "$tmp/x" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" != 1 ] || [ ! -f "$inner/setup.sh" ]; then
    die "the download does not look like the node code (no setup.sh)"
  fi
  mkdir -p "$(dirname "$dir")"
  [ ! -d "$dir" ] || rmdir "$dir"
  mv "$inner" "$dir"
  echo "$sha" > "$dir/.version"
  echo "code in $dir"

  # Handed over in the environment (not on a command line); setup.sh drops it.
  # Its input is the keyboard: with curl | bash, this script's is the download.
  GAB_NODE_KEY=$key bash "$dir/setup.sh" --server "$server" < /dev/tty
}

main "$@"
