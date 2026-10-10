#!/bin/bash
# Removes this node (macOS and Linux; uninstall.ps1 on Windows).
#
#   bash uninstall.sh [--purge] [--remove-code]
#
# 1. Tells the backend (gab-node retire): the tasks this node holds go back to
#    the queue and the node is turned off, so its token stops working.
# 2. Stops and removes the automatic start and the gab-node command.
# 3. Asks whether to delete the models it downloaded (tens of GB; kept by default).
# --purge also deletes the data folder (config, secrets file on Linux, repo
# mirrors, models: models can be many GB). It also asks whether to delete this
# code folder (--remove-code: yes, without asking; the installer uses it to reinstall).

main() {
  set -euo pipefail
  local root purge=0 remove_code=0 answer arg
  root="$(cd "$(dirname "$0")" && pwd)"
  . "$root/node-lib.sh"
  for arg in "$@"; do
    case $arg in
      --purge) purge=1 ;;
      --remove-code) remove_code=1 ;;
      *) echo "usage: bash uninstall.sh [--purge] [--remove-code]" >&2; return 1 ;;
    esac
  done

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

  # The models the node downloaded (tens of GB): kept unless you say so, so a reinstall does not download them again.
  local models size
  models="$(data_dir)/models"
  if [ "$purge" = 0 ] && [ -d "$models" ] && [ -n "$(ls -A "$models" 2> /dev/null)" ]; then
    step "Downloaded models"
    size=$(du -sh "$models" 2> /dev/null | cut -f1)
    answer=$(ask "Delete the models in $models ($size)? [y/N]")
    case $answer in
      y | Y | yes) rm -rf "$models"; echo "models removed" ;;
      *) echo "models kept" ;;
    esac
  fi

  if [ "$purge" = 1 ]; then
    step "Data folder"
    rm -rf "$(data_dir)"
    echo "removed $(data_dir)"
  else
    echo "data folder kept: $(data_dir) (bash uninstall.sh --purge deletes it)"
  fi
  if [ "$remove_code" = 0 ]; then
    answer=$(ask "Also delete the code folder $root? [y/N]")
    case $answer in y | Y | yes) remove_code=1 ;; esac
  fi
  if [ "$remove_code" = 1 ]; then
    # Last step: the running script keeps its open file, so deleting its own folder is safe.
    cd "$HOME" && rm -rf "$root"
    echo "code folder removed: $root"
  else
    echo "Code folder kept: remove it with: rm -rf \"$root\""
  fi
}

main "$@"
