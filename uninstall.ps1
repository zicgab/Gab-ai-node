# Removes this node (Windows; uninstall.sh on macOS and Linux).
#
#   Set-ExecutionPolicy -Scope Process Bypass -Force; .\uninstall.ps1 [-Purge] [-RemoveCode]
#
# 1. Tells the backend (gab-node retire): the tasks this node holds go back to
#    the queue and the node is turned off, so its token stops working.
# 2. Removes the scheduled task and the gab-node command.
# -Purge also deletes the data folder (config, encrypted token, repo mirrors,
# models: many GB). It also asks whether to delete this code folder (-RemoveCode:
# yes, without asking; a script cannot delete the folder it runs from, so a
# separate process does it after this one exits).

param([switch]$Purge, [switch]$RemoveCode)
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

# The models the node downloaded (tens of GB): kept unless you say so, so a reinstall does not download them again.
$models = Join-Path (Get-DataDir) "models"
if ((-not $Purge) -and (Test-Path $models) -and (Get-ChildItem $models -Force | Select-Object -First 1)) {
  Step "Downloaded models"
  $gb = [math]::Round((Get-ChildItem $models -Recurse -File | Measure-Object Length -Sum).Sum / 1GB, 1)
  $a = Read-Host "Delete the models in $models ($gb GB)? [y/N]"
  if ($a -match '^(y|yes)$') { Remove-Item -Recurse -Force $models; Write-Host "models removed" } else { Write-Host "models kept" }
}

if ($Purge) {
  Step "Data folder"
  Remove-Item -Recurse -Force (Get-DataDir) -ErrorAction Stop
  Write-Host "removed $(Get-DataDir)"
} else {
  Write-Host "data folder kept: $(Get-DataDir) (.\uninstall.ps1 -Purge deletes it)"
}
if (-not $RemoveCode) {
  $a = Read-Host "Also delete the code folder $root? [y/N]"
  if ($a -in @("y", "Y", "yes")) { $RemoveCode = $true }
}
if ($RemoveCode) {
  Start-Process -WindowStyle Hidden -FilePath cmd.exe -ArgumentList "/c timeout /t 3 /nobreak >nul & rmdir /s /q `"$root`""
  Write-Host "code folder $root is removed in a few seconds"
} else {
  Write-Host "Code folder kept: remove it with: Remove-Item -Recurse -Force '$root'"
}
