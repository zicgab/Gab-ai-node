#!/bin/bash
# Setup of a Gab-ai-node agent node on macOS or Linux (setup.ps1 on Windows).
# install.sh runs it on a new machine; it can also be run again by hand, as the
# user that will run the node (not with sudo), from this folder:
#
#   bash setup.sh [--server URL] [--name NAME] [--no-service] [--paused | --window 22:00-07:00 [--time-zone ZONE]]
#
# 1. Tools: Node.js 20+, git, npm (macOS: Homebrew installs what is missing;
#    Linux: asks you to install it). Docker: bug hunts and tests run their commands in it;
#    when missing, setup asks and installs it (macOS: Docker Desktop, signature checked,
#    license accepted, no window; Linux: Docker's official script), the one step that
#    needs your password. Then it starts Docker and waits for it.
# 2. Packages and build (npm ci, npm run build).
#    Then llama-server, the node's only model engine: the release pinned in
#    llama-server.pin is downloaded into the data folder, SHA-256 checked, no sudo.
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
# 6. Models: shows which of the node's three models this machine can run and asks before
#    downloading them (tens of GB; SHA-256 checked), then checks that they call tools.
# Safe to re-run. Updates later: bash update.sh. Removing: bash uninstall.sh.
#
# A new node is ALLOWED to work as soon as it registers (--paused: it starts paused; --window: only in a nightly window).

main() {
  set -euo pipefail
  local root server="" name="" no_service=0 reregister=0 paused=0
  local -a reg_extra=()
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
      --paused) reg_extra+=(--paused); paused=1; shift ;;
      --window) reg_extra+=(--window "${2:-}"); shift 2 ;;
      --time-zone) reg_extra+=(--time-zone "${2:-}"); shift 2 ;;
      *) die "unknown option $1 (--server URL, --name NAME, --no-service, --register, --paused, --window 22:00-07:00, --time-zone ZONE)" ;;
    esac
  done
  case "$(uname -s)" in Darwin | Linux) ;; *) die "this is the macOS and Linux setup (Windows: setup.ps1)" ;; esac
  [ "$(id -u)" -ne 0 ] || die "run it as the user that will run the node, without sudo"

  step "Tools"
  ensure_tools
  echo "node $(node --version), npm $(npm --version), $(git --version)"
  ensure_docker

  step "Packages and build"
  (cd "$root" && npm ci --no-audit --no-fund && npm run build)

  step "Model server (llama-server)"
  ensure_llama_server "$root"

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
      if GAB_NODE_KEY=$node_key "${cli[@]}" register --server "$server" --name "$name" ${reg_extra[@]+"${reg_extra[@]}"}; then break; fi
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

  step "Models"
  "${cli[@]}" models setup || warn "the model step did not finish (see above): run 'gab-node models setup' later"

  step "Battery"
  case "$(ask 'Let this node take tasks while the computer runs on battery? [y/N]')" in
    [yY]*) "${cli[@]}" settings battery on >/dev/null && echo "Takes tasks on battery." ;;
    *) "${cli[@]}" settings battery off >/dev/null && echo "No new task while on battery (change: gab-node settings battery on)." ;;
  esac

  "${cli[@]}" status || true

  printf '\n\033[32mDone. Next:\033[0m\n'
  if [ "$paused" = 1 ]; then echo "  1. The node is paused, as asked: allow it from Claude Code (MCP): set_node_availability node=<this node's name>"
  else echo "  1. The node is allowed to take tasks (see Registration above). Stop it: gab-node pause here, or set_node_availability from MCP"; fi
  echo "  2. Models: gab-node models list shows them; gab-node models pull --all downloads what is missing (see ARCHITECTURE.md)"
  echo "  3. Logs: $(data_dir)/logs   Status: gab-node status"
}

main "$@"
