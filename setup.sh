#!/bin/bash
# Setup of a Gab-ai-node agent node on macOS or Linux (setup.ps1 on Windows).
# install.sh runs it on a new machine; it can also be run again by hand, as the
# user that will run the node (not with sudo), from this folder:
#
#   bash setup.sh [--server URL] [--name NAME] [--no-service]
#
# 1. Tools: Node.js 20+, git, npm (macOS: Homebrew installs what is missing;
#    Linux: asks you to install it; setup never installs software with sudo). Docker is checked:
#    commands of bug hunts and tests run in it.
# 2. Packages and build (npm ci, npm run build).
# 3. Registration: this machine registers as an agent node with the node key
#    (backend NODE_API_KEY, used once and never saved: install.sh hands it over
#    in GAB_NODE_KEY). The node's own token goes to the OS secret store (macOS
#    Keychain; Linux a 0600 file in the data folder), the rest to config.json.
#    Already registered: kept (re-register: --register).
# 4. Automatic start: macOS LaunchAgent com.gabart.gab-ai-node, Linux systemd
#    user service gab-ai-node. Started now. Linux also needs "linger" so it
#    survives logout and starts at boot: tried without sudo, then (only if you
#    agree) with `sudo loginctl enable-linger`.
# 5. The gab-node command in ~/.local/bin.
# Safe to re-run. Updates later: bash update.sh. Removing: bash uninstall.sh.
#
# A new node starts PAUSED: allow it from MCP (set_node_availability).

main() {
  set -euo pipefail
  local root server="" name="" no_service=0 reregister=0
  root="$(cd "$(dirname "$0")" && pwd)"
  . "$root/node-lib.sh"
  local node_key="${GAB_NODE_KEY:-}"
  unset GAB_NODE_KEY

  while [ $# -gt 0 ]; do
    case $1 in
      --server) server=${2:-}; shift 2 ;;
      --name) name=${2:-}; shift 2 ;;
      --no-service) no_service=1; shift ;;
      --register) reregister=1; shift ;;
      *) die "unknown option $1 (--server URL, --name NAME, --no-service, --register)" ;;
    esac
  done
  case "$(uname -s)" in Darwin | Linux) ;; *) die "this is the macOS and Linux setup (Windows: setup.ps1)" ;; esac
  [ "$(id -u)" -ne 0 ] || die "run it as the user that will run the node, without sudo"

  step "Tools"
  ensure_tools
  echo "node $(node --version), npm $(npm --version), $(git --version)"
  if command -v docker > /dev/null && docker info > /dev/null 2>&1; then
    echo "docker OK"
  else
    warn "Docker is not installed or not running: 'ask' tasks work, bug hunts and tests need it"
  fi

  step "Packages and build"
  (cd "$root" && npm ci --no-audit --no-fund && npm run build)

  step "Registration"
  local cli=(node "$root/apps/node/dist/cli.js")
  if [ "$reregister" = 0 ] && "${cli[@]}" status > /dev/null 2>&1; then
    echo "already registered: $("${cli[@]}" status | sed -n 's/.*"name": "\(.*\)".*/\1/p') (re-register: bash setup.sh --register)"
  else
    server=${server%/}
    while ! [[ $server =~ $NODE_URL_RE ]]; do
      server=$(ask "Backend URL (http://<backend Tailscale IP>:3083)")
      server=${server%/}
    done
    local default
    default=$(hostname -s | tr 'A-Z' 'a-z' | sed -e 's/[^a-z0-9-]/-/g' -e 's/^-*//' -e 's/-*$//')
    while ! [[ $name =~ $NODE_NAME_RE ]]; do
      name=$(ask "Name of this node (lowercase letters, digits, dashes) [$default]")
      [ -n "$name" ] || name=$default
    done
    while :; do
      [ -n "$node_key" ] || node_key=$(ask_secret "Node key (backend NODE_API_KEY; used once, not saved)")
      if GAB_NODE_KEY=$node_key "${cli[@]}" register --server "$server" --name "$name"; then break; fi
      echo "Registration failed (see above). Wrong key? Try again, or Ctrl+C." >&2
      node_key=""
    done
    node_key=""
  fi

  if [ "$no_service" = 0 ]; then
    step "Automatic start"
    install_service "$root"
  fi

  step "gab-node command"
  install_command "$root"

  step "Models already on this machine"
  "${cli[@]}" models detect || echo "model detection failed (not fatal): run 'gab-node models detect' later"

  printf '\n\033[32mDone. Next:\033[0m\n'
  echo "  1. The node is paused: allow it from MCP (set_node_availability), e.g. with a nightly window."
  echo "  2. Models: gab-node models detect (use ones you run already) or gab-node models pull <id>   (see ARCHITECTURE.md)"
  echo "  3. Logs: $(data_dir)/logs   Status: gab-node status"
}

main "$@"
