# Starts the node and keeps it running (Windows; run-node.sh on macOS and Linux).
# Started at logon by the "Gab-ai-node" scheduled task (setup.ps1); can also be
# run by hand in a PowerShell window.
#
# Output goes to <data folder>\logs\node-<date>.log (kept 14 days). A crash
# restarts it after 30 s; a clean stop (exit 0, e.g. Ctrl+C) ends here.
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "node-lib.ps1")
$node = (Get-Command node -ErrorAction Stop).Source
$cli = Get-Cli $PSScriptRoot
if (-not (Test-Path $cli)) { throw "$cli not found: run setup.ps1" }
$logDir = Join-Path (Get-DataDir) "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

while ($true) {
  Get-ChildItem $logDir -Filter "node-*.log" |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
    Remove-Item -ErrorAction SilentlyContinue
  $log = Join-Path $logDir ("node-" + (Get-Date -Format "yyyy-MM-dd") + ".log")
  Add-Content -Path $log -Value "$(Get-Date -Format o) run-node.ps1: starting the node" -Encoding utf8

  # cmd redirection keeps the log in plain UTF-8 (PowerShell 5.1 would write UTF-16).
  # The paths go through environment variables and --% (no PowerShell parsing):
  # PowerShell 5.1 mangles quotes nested in a native argument.
  $env:GAB_RUN_NODE = $node
  $env:GAB_RUN_CLI = $cli
  $env:GAB_RUN_LOG = $log
  Push-Location $PSScriptRoot
  try {
    & cmd.exe --% /d /s /c ""%GAB_RUN_NODE%" "%GAB_RUN_CLI%" run >> "%GAB_RUN_LOG%" 2>&1"
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }

  if ($code -eq 0) {
    Add-Content -Path $log -Value "$(Get-Date -Format o) run-node.ps1: node stopped cleanly" -Encoding utf8
    break
  }
  Add-Content -Path $log -Value "$(Get-Date -Format o) run-node.ps1: node exited with code $code, restarting in 30 s" -Encoding utf8
  Start-Sleep -Seconds 30
}
