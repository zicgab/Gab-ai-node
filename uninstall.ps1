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

# Models the node downloaded through Ollama (never ones you had before): optional, they can be tens of GB.
$pulled = Join-Path (Get-DataDir) "ollama-pulled.txt"
if ((Test-Path $pulled) -and (Get-Command ollama -ErrorAction SilentlyContinue)) {
  $tags = @(Get-Content $pulled | Where-Object { $_ })
  if ($tags.Count) {
    Step "Models downloaded by this node"
    $tags | ForEach-Object { Write-Host "  $_" }
    $a = Read-Host "Remove these from Ollama too? Other apps using them lose them [y/N]"
    if ($a -match '^(y|yes)$') {
      foreach ($t in $tags) {
        & ollama rm $t
        if ($LASTEXITCODE -eq 0) { Write-Host "removed $t" } else { Write-Host "could not remove $t (is Ollama running?): ollama rm $t" -ForegroundColor Yellow }
      }
      Remove-Item -Force $pulled
    } else { Write-Host "models kept (later: ollama rm <name>)" }
  }
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
