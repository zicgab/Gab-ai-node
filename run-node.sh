#!/bin/bash
# Starts the node (macOS and Linux; run-node.ps1 on Windows). Started by the
# LaunchAgent / systemd user service that setup.sh installs, at login; it is
# started again after a crash (30 s apart), not after a clean stop (exit 0:
# SIGTERM, Ctrl+C). Can also be run by hand: bash run-node.sh
#
# Output goes to <data folder>/logs/node-<date>.log (kept 14 days).
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
. "$root/node-lib.sh"

# The service starts with a bare PATH: add where node, git and docker usually are.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
command -v node > /dev/null || { echo "$(date -u +%FT%TZ) node not found in PATH ($PATH)" >&2; exit 1; }
[ -f "$root/apps/node/dist/cli.js" ] || { echo "$(date -u +%FT%TZ) not built: run setup.sh" >&2; exit 1; }

logs="$(data_dir)/logs"
mkdir -p "$logs"
find "$logs" -name 'node-*.log' -mtime +14 -delete 2> /dev/null || true
log="$logs/node-$(date +%F).log"
echo "$(date -u +%FT%TZ) run-node.sh: starting the node" >> "$log"

cd "$root"
# exec: the node gets this process, so the service manager's SIGTERM reaches it
# (it then finishes or hands back its tasks) and the manager sees its exit code.
if is_mac && command -v caffeinate > /dev/null; then caffeinate -i -w $$ & fi
exec node "$root/apps/node/dist/cli.js" run >> "$log" 2>&1
