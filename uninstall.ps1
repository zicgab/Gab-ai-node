# Removes this node (Windows; uninstall.sh on macOS and Linux).
#
#   Set-ExecutionPolicy -Scope Process Bypass -Force; .\uninstall.ps1 [-Purge]
#
# 1. Tells the backend (gab-node retire): the tasks this node holds go back to
#    the queue and the node is turned off, so its token stops working.
# 2. Removes the scheduled task and the gab-node command.
# -Purge also deletes the data folder (config, encrypted token, repo mirrors,
# models: many GB). The code folder is left: remove it yourself when you are
# done (it cannot delete the folder it runs from).

param([switch]$Purge)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "node-lib.ps1")
$root = $PSScriptRoot

$answer = Read-Host "Remove this node from this machine and the backend? [y/N]"
if ($answer -notin @("y", "Y", "yes")) { Write-Host "nothing changed"; return }

Step "Backend"
& node (Get-Cli $root) retire
if ($LASTEXITCODE -ne 0) {
  Warn "the backend was not told (unreachable, or the node is already off). Until it is turned off there, its token still works: UPDATE ai_workers SET is_active = false WHERE project = 'agent' AND name = '<name>';"
}

Step "Scheduled task and command"
Remove-Task
Remove-Command $root
Write-Host "removed"

if ($Purge) {
  Step "Data folder"
  Remove-Item -Recurse -Force (Get-DataDir) -ErrorAction Stop
  Write-Host "removed $(Get-DataDir)"
} else {
  Write-Host "data folder kept: $(Get-DataDir) (.\uninstall.ps1 -Purge deletes it)"
}
Write-Host "Code folder kept: remove it with: Remove-Item -Recurse -Force '$root'"
