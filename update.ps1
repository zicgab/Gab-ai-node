# Updates this node to the latest code of the backend's branch (Windows; update.sh
# on macOS and Linux). Uses the node's own token (not the node key): turning the
# node off on the backend also stops its updates.
#
#   Set-ExecutionPolicy -Scope Process Bypass -Force; .\update.ps1 [-Force]
#
# Stops the node (tasks it held come back to the queue when their lease runs
# out), swaps in the new code, installs the packages and builds. If that fails
# the old code is put back and the node is started again. The data folder
# (config, models, repos) is outside the code folder and never touched.

param([switch]$Force)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "node-lib.ps1")
$root = $PSScriptRoot
$cli = Get-Cli $root
$tmp = Join-Path $env:TEMP "gab-ai-node-update"
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
  Step "Latest version"
  & node $cli fetch version (Join-Path $tmp "version.json")
  if ($LASTEXITCODE -ne 0) { throw "Could not ask the backend (is this node turned off, or Tailscale down?)" }
  $sha = (Get-Content (Join-Path $tmp "version.json") -Raw | ConvertFrom-Json).sha
  if ($sha -notmatch '^[0-9a-f]{40}$') { throw "The backend's answer has no version." }
  $versionFile = Join-Path $root ".version"
  $current = if (Test-Path $versionFile) { (Get-Content $versionFile -Raw).Trim() } else { "none" }
  Write-Host "installed $($current.Substring(0, [Math]::Min(7, $current.Length))), latest $($sha.Substring(0, 7))"
  if ($sha -eq $current -and -not $Force) { Write-Host "up to date (.\update.ps1 -Force to reinstall)"; return }

  Step "Download"
  $zip = Join-Path $tmp "code.zip"
  & node $cli fetch code $zip $sha
  if ($LASTEXITCODE -ne 0) { throw "Download failed." }
  $unpacked = Join-Path $tmp "x"
  Expand-Archive -Path $zip -DestinationPath $unpacked -Force
  $inner = @(Get-ChildItem -Path $unpacked -Directory)
  if ($inner.Count -ne 1 -or -not (Test-Path (Join-Path $inner[0].FullName "setup.ps1"))) { throw "The download does not look like the node code (no setup.ps1)." }

  Step "Swap"
  $old = "$root.old"
  if (Test-Path $old) { throw "$old exists (an earlier update stopped halfway): check it, then remove it." }
  Stop-Node
  # A folder in use as a working directory cannot be renamed.
  Set-Location (Split-Path $root -Parent)
  Rename-Item -Path $root -NewName (Split-Path $old -Leaf)
  Move-Item -Path $inner[0].FullName -Destination $root
  Get-ChildItem -Path $root -Recurse -File | Unblock-File
  Set-Content -Path (Join-Path $root ".version") -Value $sha -Encoding ascii
  try {
    Push-Location $root
    try {
      Invoke-Checked "npm.cmd" @("ci", "--no-audit", "--no-fund")
      Invoke-Checked "npm.cmd" @("run", "build")
      # The new code's node-lib.ps1 (the one loaded above is the old one) also brings the pinned llama-server up to date.
      . (Join-Path $root "node-lib.ps1")
      Install-LlamaServer $root
    } finally { Pop-Location }
  } catch {
    Write-Host "The new code did not install, build or get its llama-server: putting the old code back" -ForegroundColor Yellow
    Set-Location (Split-Path $root -Parent)
    Remove-Item -Recurse -Force $root
    Rename-Item -Path $old -NewName (Split-Path $root -Leaf)
    Start-Node
    throw "Update failed, still on $current. $($_.Exception.Message)"
  }
  Remove-Item -Recurse -Force $old
  Start-Node
  Write-Host "updated to $($sha.Substring(0, 7)); the node runs again"
  # Models this machine can run but does not have yet (also the first update from a version that used Ollama): asks before downloading.
  try { & node (Join-Path $root "apps\node\dist\cli.js") models setup --if-missing; if ($LASTEXITCODE -ne 0) { throw "exit $LASTEXITCODE" } }
  catch { Write-Host "the model step did not finish (not fatal): run 'gab-node models setup' later: $_" -ForegroundColor Yellow }
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
