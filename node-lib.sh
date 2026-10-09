#!/bin/bash
# Shared by setup.sh, update.sh and uninstall.sh (macOS and Linux). Sourced, not run.

LAUNCHD_LABEL=com.gabart.gab-ai-node
SYSTEMD_UNIT=gab-ai-node.service
NODE_URL_RE='^https?://[^/<>[:space:]]+$'
NODE_NAME_RE='^[a-z0-9][a-z0-9-]{1,48}$'

step() { printf '\n\033[36m== %s\033[0m\n' "$1" >&2; }
warn() { printf '\033[33mWarning: %s\033[0m\n' "$1" >&2; }
die() { printf '\033[31mError: %s\033[0m\n' "$1" >&2; exit 1; }

is_mac() { [ "$(uname -s)" = Darwin ]; }

# Same folder as apps/node/src/paths.ts (GAB_NODE_HOME overrides it).
data_dir() {
  if [ -n "${GAB_NODE_HOME:-}" ]; then printf '%s' "$GAB_NODE_HOME"
  elif is_mac; then printf '%s' "$HOME/Library/Application Support/gab-ai-node"
  else printf '%s' "${XDG_DATA_HOME:-$HOME/.local/share}/gab-ai-node"
  fi
}

# ask <prompt> -> the answer, from the terminal (also when stdin is a pipe).
ask() {
  local answer
  printf '%s: ' "$1" > /dev/tty
  IFS= read -r answer < /dev/tty
  printf '%s' "$answer" | tr -d '[:space:]'
}

# ask_secret <prompt> -> the answer, not echoed.
ask_secret() {
  local answer
  printf '%s: ' "$1" > /dev/tty
  IFS= read -rs answer < /dev/tty
  printf '\n' > /dev/tty
  printf '%s' "$answer" | tr -d '[:space:]'
}

node_ok() {
  command -v node > /dev/null && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'
}

# Node 20+, npm, git. macOS: Homebrew; Linux: you install them (no sudo here).
ensure_tools() {
  if is_mac; then
    if ! command -v brew > /dev/null; then
      for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)" && break; done
    fi
    command -v brew > /dev/null || die "Homebrew is needed on macOS: https://brew.sh"
    node_ok || brew install node
    command -v git > /dev/null || brew install git
  fi
  node_ok || die "Node.js 20 or later is needed (Linux: your package manager, or https://nodejs.org)"
  command -v npm > /dev/null || die "npm is needed (it comes with Node.js)"
  command -v git > /dev/null || die "git is needed"
}

# install_service <root>: starts run-node.sh at login and after a crash, now.
install_service() {
  local root=$1 run="$1/run-node.sh"
  chmod +x "$run"
  if is_mac; then
    local plist="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"
    mkdir -p "$(dirname "$plist")" "$(data_dir)/logs"
    cat > "$plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LAUNCHD_LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$run</string></array>
  <key>RunAtLoad</key><true/>
  <!-- Restart after a crash (30 s apart), not after a clean stop (exit 0). -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>WorkingDirectory</key><string>$root</string>
  <key>StandardOutPath</key><string>$(data_dir)/logs/launchd.log</string>
  <key>StandardErrorPath</key><string>$(data_dir)/logs/launchd.log</string>
</dict></plist>
EOF
    launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" > /dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$plist" || die "launchd refused $plist"
    echo "LaunchAgent $LAUNCHD_LABEL started (logs: $(data_dir)/logs)"
  else
    command -v systemctl > /dev/null || die "systemd is needed for the automatic start (or run: bash setup.sh --no-service, and start run-node.sh yourself)"
    local unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$SYSTEMD_UNIT"
    mkdir -p "$(dirname "$unit")"
    cat > "$unit" << EOF
[Unit]
Description=Gab-ai-node agent node
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/bin/bash $run
WorkingDirectory=$root
# Restart after a crash, not after a clean stop (exit 0).
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now "$SYSTEMD_UNIT" || die "systemd refused the service (is a user session running? try: loginctl enable-linger $USER)"
    enable_linger
    echo "systemd user service $SYSTEMD_UNIT started (logs: journalctl --user -u $SYSTEMD_UNIT, and $(data_dir)/logs)"
  fi
}

# Without linger the user service stops at logout and does not start at boot.
# Most distros let a user enable it for themselves; otherwise (e.g. over SSH)
# the only sudo in setup is this one command, and only after asking.
enable_linger() {
  local user
  user=$(id -un)
  if [ "$(loginctl show-user "$user" -p Linger --value 2> /dev/null)" = yes ]; then
    echo "linger already on: the node survives logout and starts at boot"
    return 0
  fi
  if loginctl enable-linger "$user" 2> /dev/null; then
    echo "linger enabled: the node survives logout and starts at boot"
    return 0
  fi
  if command -v sudo > /dev/null && [ -r /dev/tty ]; then
    local answer
    answer=$(ask "Linger needs admin rights here. Run 'sudo loginctl enable-linger $user'? [y/N]")
    case $answer in y | Y | yes)
      if sudo loginctl enable-linger "$user"; then echo "linger enabled"; return 0; fi ;;
    esac
  fi
  warn "linger is off: the node stops when you log out and does not start at boot. Fix: sudo loginctl enable-linger $user"
}

stop_service() {
  if is_mac; then
    launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" > /dev/null 2>&1 || true
  else
    systemctl --user stop "$SYSTEMD_UNIT" > /dev/null 2>&1 || true
  fi
}

start_service() {
  if is_mac; then
    local plist="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"
    [ -f "$plist" ] && launchctl bootstrap "gui/$(id -u)" "$plist"
  else
    systemctl --user start "$SYSTEMD_UNIT" > /dev/null 2>&1 || true
  fi
}

remove_service() {
  stop_service
  if is_mac; then
    rm -f "$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"
  else
    systemctl --user disable "$SYSTEMD_UNIT" > /dev/null 2>&1 || true
    rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$SYSTEMD_UNIT"
    systemctl --user daemon-reload > /dev/null 2>&1 || true
  fi
}

# install_command <root>: ~/.local/bin/gab-node -> the CLI.
install_command() {
  local root=$1 bin="$HOME/.local/bin"
  mkdir -p "$bin"
  cat > "$bin/gab-node" << EOF
#!/bin/bash
exec node "$root/apps/node/dist/cli.js" "\$@"
EOF
  chmod +x "$bin/gab-node"
  echo "gab-node command in $bin"
  # macOS and many Linux setups do not put ~/.local/bin in PATH: add it once to the shell's rc file.
  local rc
  rc=$(shell_rc_file)
  if ! grep -qF "$GAB_PATH_MARK" "$rc" 2> /dev/null; then
    printf '\n%s\nexport PATH="$HOME/.local/bin:$PATH"\n' "$GAB_PATH_MARK" >> "$rc"
    echo "added $bin to PATH in $rc"
  fi
  case ":$PATH:" in *":$bin:"*) ;; *) warn "open a new terminal (or run: source $rc) to use gab-node" ;; esac
}

GAB_PATH_MARK='# gab-ai-node: gab-node command'

# The rc file a new terminal of the user's shell reads.
shell_rc_file() {
  case "$(basename "${SHELL:-}")" in
    zsh) echo "$HOME/.zshrc" ;;
    bash) if [ "$(uname -s)" = Darwin ]; then echo "$HOME/.bash_profile"; else echo "$HOME/.bashrc"; fi ;;
    *) echo "$HOME/.profile" ;;
  esac
}

remove_command() {
  local rc
  rm -f "$HOME/.local/bin/gab-node"
  for rc in "$HOME/.zshrc" "$HOME/.bash_profile" "$HOME/.bashrc" "$HOME/.profile"; do
    [ -f "$rc" ] && grep -qF "$GAB_PATH_MARK" "$rc" || continue
    # Drop the mark line and the export line after it.
    awk -v m="$GAB_PATH_MARK" '$0 == m { skip = 1; next } skip { skip = 0; next } { print }' "$rc" > "$rc.gab-tmp" && mv "$rc.gab-tmp" "$rc"
  done
}
