# Installs a Gab-ai-node agent node on Windows (install.sh on macOS and Linux).
# The backend serves this file (gasysteme ai-worker/nodes.js) and writes its own
# address into the placeholder below ($env:GAB_NODE_SERVER overrides it). With
# Tailscale connected, in PowerShell, as the account that will run the node
# (elevation is not needed):
#
#   irm http://<backend Tailscale IP>:3083/node/agent | iex
#
# Asks for the node key (backend NODE_API_KEY; used to download and register,
# never saved), downloads the latest code into %USERPROFILE%\gab-ai-node
# (another folder: set $env:GAB_NODE_DIR first), then runs its setup.ps1
# (packages, build, registration, automatic start). Later: update.ps1 in that folder.
# Runs as a script block: never closes the window, keeps nothing in the session.

& {
  $ErrorActionPreference = "Stop"
  $project = "agent"

  $server = if ($env:GAB_NODE_SERVER) { "$env:GAB_NODE_SERVER" } else { '__GAB_NODE_SERVER__' }
  $server = $server.Trim().TrimEnd("/")
  if ($server -notmatch '^https?://[^/<>\s]+$') { throw 'Run it from the backend: irm http://<backend Tailscale IP>:3083/node/agent | iex' }
  $dir = if ($env:GAB_NODE_DIR) { $env:GAB_NODE_DIR } else { Join-Path $env:USERPROFILE "gab-ai-node" }
  if (Test-Path (Join-Path $dir ".version")) {
    throw "Already installed in $dir. Setup stopped halfway: cd $dir; .\setup.ps1 (safe to re-run). Update: .\update.ps1"
  }
  if ((Test-Path $dir) -and (Get-ChildItem -Path $dir -Force | Select-Object -First 1)) {
    throw "$dir exists and is not empty. Empty it, or set `$env:GAB_NODE_DIR to another folder."
  }

  $secure = Read-Host "Node key (backend NODE_API_KEY)" -AsSecureString
  $key = [Net.NetworkCredential]::new("", $secure).Password.Trim()
  if (-not $key) { throw "No node key given." }
  $headers = @{ Authorization = "Bearer $key" }
  $failure = {
    param($err)
    if ($err.ErrorDetails -and $err.ErrorDetails.Message) {
      try { return ($err.ErrorDetails.Message | ConvertFrom-Json).message } catch { return $err.ErrorDetails.Message }
    }
    return $err.Exception.Message
  }

  Write-Host "`n== Latest version" -ForegroundColor Cyan
  try { $version = Invoke-RestMethod -Uri "$server/node/$project/version" -Headers $headers -UseBasicParsing }
  catch { throw "The backend refused: $(& $failure $_)" }
  if ($version.sha -notmatch '^[0-9a-f]{40}$') { throw "The backend's answer has no version." }
  $short = $version.sha.Substring(0, 7)
  Write-Host "$short ($($version.date)): $($version.message)"

  Write-Host "`n== Download" -ForegroundColor Cyan
  $zip = Join-Path $env:TEMP "gab-ai-node-$short.zip"
  $unpacked = Join-Path $env:TEMP "gab-ai-node-$short"
  Remove-Item -Recurse -Force $zip, $unpacked -ErrorAction SilentlyContinue
  $ProgressPreference = "SilentlyContinue" # the progress bar makes downloads very slow in 5.1
  try { Invoke-WebRequest -Uri "$server/node/$project/code?ref=$($version.sha)" -Headers $headers -OutFile $zip -UseBasicParsing }
  catch { throw "Download failed: $(& $failure $_)" }
  Expand-Archive -Path $zip -DestinationPath $unpacked -Force
  $inner = @(Get-ChildItem -Path $unpacked -Directory)
  if ($inner.Count -ne 1 -or -not (Test-Path (Join-Path $inner[0].FullName "setup.ps1"))) { throw "The download does not look like the node code (no setup.ps1)." }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Get-ChildItem -Path $inner[0].FullName -Force | Move-Item -Destination $dir
  Remove-Item -Recurse -Force $zip, $unpacked
  Get-ChildItem -Path $dir -Recurse -File | Unblock-File
  Set-Content -Path (Join-Path $dir ".version") -Value $version.sha -Encoding ascii
  Write-Host "code in $dir"

  Set-ExecutionPolicy -Scope Process Bypass -Force
  & (Join-Path $dir "setup.ps1") -Server $server -NodeKey $key
}
