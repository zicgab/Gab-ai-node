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

# --- Docker -------------------------------------------------------------------
# Bug hunts and tests run their commands in Docker. Setup installs it when it is missing
# (after asking: it needs the admin password once) and starts it without a window; the
# node starts it again by itself later (apps/node/src/docker.ts).

DOCKER_TEAM_ID=9BNSXJN65R # Docker Inc's Apple developer team: the app must be signed by it

docker_up() {
  local bin
  bin=$(command -v docker || true)
  [ -z "$bin" ] && [ -x /Applications/Docker.app/Contents/Resources/bin/docker ] && bin=/Applications/Docker.app/Contents/Resources/bin/docker
  [ -n "$bin" ] && "$bin" info > /dev/null 2>&1
}

# Docker Desktop: start at login, never open its window (the dashboard).
docker_desktop_quiet() {
  local dir="$HOME/Library/Group Containers/group.com.docker"
  mkdir -p "$dir"
  node -e '
    const fs = require("fs"); const f = process.argv[1];
    let s = {}; try { s = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
    Object.assign(s, { AutoStart: true, OpenUIOnStartupDisabled: true, DisplayedOnboarding: true });
    fs.writeFileSync(f, JSON.stringify(s, null, 2));
  ' "$dir/settings-store.json" || warn "could not write Docker Desktop settings (it may open its window once)"
}

wait_for_docker() {
  local i
  for i in $(seq 1 90); do docker_up && return 0; sleep 2; done
  return 1
}

install_docker_mac() {
  local arch tmp mnt
  case "$(uname -m)" in arm64) arch=arm64 ;; *) arch=amd64 ;; esac
  tmp=$(mktemp -d) && mnt="$tmp/mnt"
  echo "downloading Docker Desktop ($arch, about 600 MB)..."
  curl -fL --retry 5 --retry-delay 3 -C - -o "$tmp/Docker.dmg" "https://desktop.docker.com/mac/main/$arch/Docker.dmg" \
    || { rm -rf "$tmp"; warn "Docker Desktop download failed"; return 1; }
  mkdir -p "$mnt"
  hdiutil attach -nobrowse -readonly -quiet -mountpoint "$mnt" "$tmp/Docker.dmg" || { rm -rf "$tmp"; warn "could not open Docker.dmg"; return 1; }
  if ! codesign --verify --deep --strict "$mnt/Docker.app" 2> /dev/null \
    || ! codesign -dv "$mnt/Docker.app" 2>&1 | grep -q "^TeamIdentifier=$DOCKER_TEAM_ID$"; then
    hdiutil detach -quiet "$mnt"; rm -rf "$tmp"
    warn "Docker.app is not signed by Docker Inc ($DOCKER_TEAM_ID): not installed"; return 1
  fi
  echo "installing Docker Desktop (license accepted for you; enter your Mac password)"
  local ok=0
  sudo "$mnt/Docker.app/Contents/MacOS/install" --accept-license --user="$(id -un)" || ok=1
  hdiutil detach -quiet "$mnt" || true
  rm -rf "$tmp"
  [ $ok -eq 0 ] || { warn "the Docker Desktop installer failed"; return 1; }
}

install_docker_linux() {
  local tmp
  tmp=$(mktemp -d)
  curl -fsSL --retry 5 -o "$tmp/get-docker.sh" https://get.docker.com || { rm -rf "$tmp"; warn "could not download Docker's install script"; return 1; }
  echo "installing Docker Engine with Docker's official script (enter your password)"
  sudo sh "$tmp/get-docker.sh" || { rm -rf "$tmp"; warn "Docker's install script failed"; return 1; }
  rm -rf "$tmp"
  sudo systemctl enable --now docker || warn "could not enable the docker service"
  sudo usermod -aG docker "$(id -un)" || warn "could not add $(id -un) to the docker group"
  warn "log out and back in (or reboot) once so the node may use Docker (docker group)"
}

# ensure_docker: running -> OK; installed -> start it; missing -> ask, install, start.
ensure_docker() {
  if docker_up; then echo "docker OK"; return 0; fi
  local installed=0
  if is_mac; then [ -d /Applications/Docker.app ] && installed=1; else command -v docker > /dev/null && installed=1; fi
  if [ $installed -eq 0 ]; then
    if [ ! -r /dev/tty ]; then
      warn "Docker is not installed: bug hunts and tests stay off until it is (run setup again in a terminal to install it)"
      return 0
    fi
    local answer
    answer=$(ask "Docker is not installed. Bug hunts and tests need it. Install it now (needs your password once)? [Y/n]")
    case $answer in n | N | no) warn "Docker skipped: 'ask' tasks work, bug hunts and tests stay off (later: bash setup.sh)"; return 0 ;; esac
    if is_mac; then install_docker_mac || return 0; else install_docker_linux || return 0; fi
  fi
  if is_mac; then
    docker_desktop_quiet
    open -g -j -a Docker || { warn "could not start Docker Desktop"; return 0; }
  else
    systemctl is-active --quiet docker || sudo systemctl start docker || true
  fi
  echo "waiting for Docker to start (up to 3 minutes)..."
  if wait_for_docker; then echo "docker OK"; else warn "Docker did not come up yet; the node starts it again by itself and enables bug hunts once it runs"; fi
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

# The pinned llama-server (llama-server.pin) goes to <data folder>/llama.cpp/bin, the path
# apps/node/src/config.ts expects. A `.version` file there holds "<tag> <sha256>" of what is installed.
llama_dir() { printf '%s' "$(data_dir)/llama.cpp"; }

sha256_of() {
  if command -v shasum > /dev/null; then shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v sha256sum > /dev/null; then sha256sum "$1" | cut -d' ' -f1
  else die "shasum or sha256sum is needed to check the download"
  fi
}

# llama_variant: the pin's variant for this machine. Vulkan builds when a Vulkan loader is present.
llama_variant() {
  local arch vulkan=""
  arch=$(uname -m)
  case "$(uname -s)-$arch" in
    Darwin-arm64) echo macos-arm64; return ;;
    Darwin-x86_64) echo macos-x64; return ;;
  esac
  if command -v ldconfig > /dev/null && ldconfig -p 2> /dev/null | grep -q 'libvulkan\.so\.1'; then vulkan=-vulkan; fi
  case $arch in
    x86_64) echo "linux-x64$vulkan" ;;
    aarch64 | arm64) echo "linux-arm64$vulkan" ;;
    *) die "no llama-server build is pinned for $(uname -s) $arch" ;;
  esac
}

# ensure_llama_server <root>: installs (or upgrades to) the pinned llama-server, hash-checked, no sudo.
ensure_llama_server() {
  local root=$1 pin="$1/llama-server.pin" tag variant file sha base tmp
  [ -f "$pin" ] || die "$pin is missing"
  tag=$(awk '$1 == "tag" { print $2 }' "$pin")
  variant=$(llama_variant)
  read -r file sha < <(awk -v v="$variant" '$1 == "asset" && $2 == v { print $3, $4 }' "$pin")
  [ -n "${file:-}" ] && [ -n "${sha:-}" ] && [ -n "$tag" ] || die "llama-server.pin has no build for '$variant'"
  base=$(llama_dir)
  if [ "$(cat "$base/bin/.version" 2> /dev/null)" = "$tag $sha" ] && [ -x "$base/bin/llama-server" ]; then
    echo "llama-server $tag ($variant) already installed"
    return 0
  fi
  command -v curl > /dev/null || die "curl is needed"
  mkdir -p "$base"
  tmp=$(mktemp -d "$base/.install.XXXXXX")
  fail() { rm -rf "$tmp"; die "$1"; }
  echo "Downloading llama-server $tag ($variant)..."
  curl -fL --progress-bar --connect-timeout 20 --retry 3 -o "$tmp/pkg.tar.gz" "https://github.com/ggml-org/llama.cpp/releases/download/$tag/$file" \
    || fail "could not download $file"
  [ "$(sha256_of "$tmp/pkg.tar.gz")" = "$sha" ] || fail "$file does not match the pinned SHA-256 (llama-server.pin): not installed"
  mkdir "$tmp/x"
  tar -xzf "$tmp/pkg.tar.gz" -C "$tmp/x" --strip-components=1 || fail "could not unpack $file"
  [ -f "$tmp/x/llama-server" ] || fail "$file has no llama-server"
  chmod +x "$tmp/x/llama-server"
  # curl does not set the macOS quarantine flag; clear it anyway in case one was added.
  if is_mac; then xattr -dr com.apple.quarantine "$tmp/x" 2> /dev/null || true; fi
  echo "$tag $sha" > "$tmp/x/.version"
  rm -rf "$base/bin"
  mv "$tmp/x" "$base/bin"
  rm -rf "$tmp"
  "$base/bin/llama-server" --version > /dev/null 2>&1 || die "the installed llama-server does not start on this machine ($variant)"
  echo "llama-server $tag installed in $base/bin"
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
    launchd_unload
    launchd_load "$plist" || die "launchd refused $plist (see: launchctl print gui/$(id -u)/$LAUNCHD_LABEL)"
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

# bootout returns before the node has stopped (it shuts its model servers down first);
# a bootstrap meanwhile fails with "5: Input/output error". Wait until launchd lets go.
launchd_unload() {
  local target="gui/$(id -u)/$LAUNCHD_LABEL" i
  launchctl bootout "$target" > /dev/null 2>&1 || return 0
  for i in $(seq 1 30); do
    launchctl print "$target" > /dev/null 2>&1 || return 0
    sleep 1
  done
  warn "the node did not stop within 30 s"
}

launchd_load() {
  local i
  for i in 1 2 3 4 5; do
    launchctl bootstrap "gui/$(id -u)" "$1" 2> /dev/null && return 0
    sleep 2
  done
  launchctl bootstrap "gui/$(id -u)" "$1"
}

stop_service() {
  if is_mac; then
    launchd_unload
  else
    systemctl --user stop "$SYSTEMD_UNIT" > /dev/null 2>&1 || true
  fi
}

start_service() {
  if is_mac; then
    local plist="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"
    [ -f "$plist" ] && launchd_load "$plist"
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
