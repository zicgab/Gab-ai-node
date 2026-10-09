# Setup of a Gab-ai-node agent node on Windows (setup.sh on macOS and Linux).
# install.ps1 runs it on a new machine; it can also be run again by hand, as the
# account that will run the node, from this folder:
#
#   Set-ExecutionPolicy -Scope Process Bypass -Force; .\setup.ps1 [-Server URL] [-Name NAME] [-NoService] [-Register]
#
# 1. Tools: Node.js 20+, npm, git must be installed (setup never installs
#    software). Docker is checked: commands of bug hunts and tests run in it.
# 2. Packages and build (npm ci, npm run build).
#    Then llama-server, the node's only model engine: the release pinned in
#    llama-server.pin is downloaded into the data folder and SHA-256 checked.
# 3. Registration: this machine registers as an agent node with the node key
#    (backend NODE_API_KEY, used once and never saved: install.ps1 hands it
#    over in -NodeKey). The node's own token is encrypted with DPAPI for this
#    account (apps/node/src/secrets/dpapi.ts); the rest goes to config.json.
#    Already registered: kept (-Register registers again).
# 4. Automatic start: the scheduled task "Gab-ai-node" at logon. Started now.
# 5. The gab-node command (gab-node.cmd, this folder on your PATH).
# Safe to re-run. Updates later: .\update.ps1. Removing: .\uninstall.ps1.
#
# A new node starts PAUSED: allow it from MCP (set_node_availability).

param(
  [string]$Server = "",
  [string]$Name = "",
  [string]$NodeKey = "",
  [switch]$NoService,
  [switch]$Register
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "node-lib.ps1")
$root = $PSScriptRoot
$cli = Get-Cli $root

Step "Tools"
Assert-Tools

Step "Packages and build"
Push-Location $root
try {
  Invoke-Checked "npm.cmd" @("ci", "--no-audit", "--no-fund")
  Invoke-Checked "npm.cmd" @("run", "build")
} finally { Pop-Location }

Step "Model server (llama-server)"
Install-LlamaServer $root

Step "Registration"
$registered = $false
if (-not $Register) { & node $cli status *> $null; $registered = ($LASTEXITCODE -eq 0) }
if ($registered) {
  Write-Host "already registered: $((& node $cli status | ConvertFrom-Json).name) (register again: .\setup.ps1 -Register)"
} else {
  $Server = $Server.Trim().TrimEnd("/")
  while ($Server -notmatch $NodeUrlRe) { $Server = (Read-Host "Backend URL (http://<backend Tailscale IP>:3083)").Trim().TrimEnd("/") }
  $default = ($env:COMPUTERNAME.ToLower() -replace '[^a-z0-9-]', '-').Trim('-')
  while ($Name -notmatch $NodeNameRe) {
    $Name = (Read-Host "Name of this node (lowercase letters, digits, dashes) [$default]").Trim()
    if (-not $Name) { $Name = $default }
  }
  while ($true) {
    if (-not $NodeKey) { $NodeKey = Read-Secret "Node key (backend NODE_API_KEY; used once, not saved)" }
    # The key goes to the CLI through the environment of this one command, never on a command line.
    $env:GAB_NODE_KEY = $NodeKey
    try { & node $cli register --server $Server --name $Name; $code = $LASTEXITCODE } finally { Remove-Item Env:\GAB_NODE_KEY -ErrorAction SilentlyContinue }
    if ($code -eq 0) { break }
    Write-Host "Registration failed (see above). Wrong key? Try again, or Ctrl+C." -ForegroundColor Yellow
    $NodeKey = ""
  }
  $NodeKey = ""
}

if (-not $NoService) {
  Step "Automatic start"
  Install-Task $root
}

Step "gab-node command"
Install-Command $root

Step "Models already on this machine"
try { & node $cli models detect; if ($LASTEXITCODE -ne 0) { throw "exit $LASTEXITCODE" } }
catch { Write-Host "model detection failed (not fatal): run 'gab-node models detect' later: $_" -ForegroundColor Yellow }

Step "Battery"
if ((Read-Host "Let this node take tasks while the computer runs on battery? [y/N]").Trim() -match '^[yY]') {
  & node $cli settings battery on | Out-Null; Write-Host "Takes tasks on battery."
} else {
  & node $cli settings battery off | Out-Null; Write-Host "No new task while on battery (change: gab-node settings battery on)."
}

& node $cli status

Write-Host "`nDone. Next:" -ForegroundColor Green
Write-Host "  1. The node is paused: on purpose. Allow it from Claude Code (MCP): set_node_availability node=<this node's name> (always, or a nightly window)."
Write-Host "  2. Models: gab-node models detect (use ones you run already) or gab-node models pull <id>   (see ARCHITECTURE.md)"
Write-Host "  3. Logs: $(Join-Path (Get-DataDir) 'logs')   Status: gab-node status"
