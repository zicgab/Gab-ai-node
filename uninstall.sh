#!/bin/bash
# Removes this node (macOS and Linux; uninstall.ps1 on Windows).
#
#   bash uninstall.sh [--purge]
#
# 1. Tells the backend (gab-node retire): the tasks this node holds go back to
#    the queue and the node is turned off, so its token stops working.
# 2. Stops and removes the automatic start and the gab-node command.
# --purge also deletes the data folder (config, secrets file on Linux, repo
# mirrors, models: models can be many GB). The code folder is left: remove it
# yourself when you are done (rm -rf <this folder>).

main() {
  set -euo pipefail
  local root purge=0 answer
  root="$(cd "$(dirname "$0")" && pwd)"
  . "$root/node-lib.sh"
  [ "${1:-}" != --purge ] || purge=1

  answer=$(ask "Remove this node from this machine and the backend? [y/N]")
  case $answer in y | Y | yes) ;; *) echo "nothing changed"; return 0 ;; esac

  step "Backend"
  if node "$root/apps/node/dist/cli.js" retire; then
    :
  else
    warn "the backend was not told (unreachable, or the node is already off). Until it is turned off there, its token still works: UPDATE ai_workers SET is_active = false WHERE project = 'agent' AND name = '<name>';"
  fi

  step "Service and command"
  remove_service
  remove_command
  echo "removed"

  if [ "$purge" = 1 ]; then
    step "Data folder"
    rm -rf "$(data_dir)"
    echo "removed $(data_dir)"
  else
    echo "data folder kept: $(data_dir) (bash uninstall.sh --purge deletes it)"
  fi
  echo "Code folder kept: remove it with: rm -rf \"$root\""
}

main "$@"
