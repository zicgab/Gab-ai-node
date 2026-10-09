# Shared by setup.ps1, update.ps1 and uninstall.ps1 (Windows). Dot-sourced, not run.

$TaskName = "Gab-ai-node"
$NodeUrlRe = '^https?://[^/<>\s]+$'
$NodeNameRe = '^[a-z0-9][a-z0-9-]{1,48}$'

function Step($message) { Write-Host "`n== $message" -ForegroundColor Cyan }
function Warn($message) { Write-Host "Warning: $message" -ForegroundColor Yellow }

# Same folder as apps/node/src/paths.ts (GAB_NODE_HOME overrides it).
function Get-DataDir {
  if ($env:GAB_NODE_HOME) { return $env:GAB_NODE_HOME }
  $base = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE "AppData\Local" }
  return Join-Path $base "gab-ai-node"
}

# The pinned llama-server (llama-server.pin) goes to <data folder>\llama.cpp\bin, the path
# apps/node/src/config.ts expects. A ".version" file there holds "<tag> <sha256>" of what is installed.
function Install-LlamaServer($root) {
  $pin = Join-Path $root "llama-server.pin"
  if (-not (Test-Path $pin)) { throw "$pin is missing" }
  $lines = Get-Content $pin | Where-Object { $_ -and -not $_.StartsWith("#") } | ForEach-Object { , ($_ -split '\s+') }
  $tag = ($lines | Where-Object { $_[0] -eq "tag" } | Select-Object -First 1)[1]
  $arch = switch ($env:PROCESSOR_ARCHITECTURE) { "AMD64" { "x64" } "ARM64" { "arm64" } default { throw "no llama-server build is pinned for $($env:PROCESSOR_ARCHITECTURE)" } }
  # Vulkan build when a Vulkan loader is installed (NVIDIA, AMD and Intel drivers bring it); there is no arm64 Vulkan pin.
  $vulkan = ($arch -eq "x64") -and (Test-Path (Join-Path $env:SystemRoot "System32\vulkan-1.dll"))
  $variant = "win-$arch$(if ($vulkan) { '-vulkan' })"
  $asset = $lines | Where-Object { $_[0] -eq "asset" -and $_[1] -eq $variant } | Select-Object -First 1
  if (-not $tag -or -not $asset) { throw "llama-server.pin has no build for '$variant'" }
  $file = $asset[2]; $sha = $asset[3].ToLower()

  $base = Join-Path (Get-DataDir) "llama.cpp"
  $bin = Join-Path $base "bin"
  $versionFile = Join-Path $bin ".version"
  if ((Test-Path (Join-Path $bin "llama-server.exe")) -and (Test-Path $versionFile) -and ((Get-Content $versionFile -Raw).Trim() -eq "$tag $sha")) {
    Write-Host "llama-server $tag ($variant) already installed"
    return
  }
  New-Item -ItemType Directory -Force -Path $base | Out-Null
  $tmp = Join-Path $base (".install." + [guid]::NewGuid().ToString("N").Substring(0, 8))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    Write-Host "Downloading llama-server $tag ($variant)..."
    $zip = Join-Path $tmp "pkg.zip"
    $previous = $ProgressPreference
    $ProgressPreference = "SilentlyContinue"  # the progress bar makes Invoke-WebRequest very slow
    try { Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/ggml-org/llama.cpp/releases/download/$tag/$file" -OutFile $zip }
    finally { $ProgressPreference = $previous }
    if ((Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower() -ne $sha) { throw "$file does not match the pinned SHA-256 (llama-server.pin): not installed" }
    $x = Join-Path $tmp "x"
    Expand-Archive -Path $zip -DestinationPath $x
    if (-not (Test-Path (Join-Path $x "llama-server.exe"))) { throw "$file has no llama-server.exe" }
    Get-ChildItem -Path $x -Recurse -File | Unblock-File
    Set-Content -Path (Join-Path $x ".version") -Value "$tag $sha" -Encoding ascii
    if (Test-Path $bin) { Remove-Item -Recurse -Force $bin }
    Move-Item -Path $x -Destination $bin
  } finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
  & (Join-Path $bin "llama-server.exe") --version *> $null
  if ($LASTEXITCODE -ne 0) { throw "the installed llama-server does not start on this machine ($variant)" }
  Write-Host "llama-server $tag installed in $bin"
}

# Runs a program and throws when it fails (PowerShell does not on its own).
function Invoke-Checked($exe, [string[]]$arguments) {
  & $exe @arguments
  if ($LASTEXITCODE -ne 0) { throw "$exe $($arguments -join ' ') failed (exit code $LASTEXITCODE)" }
}

function Read-Secret($prompt) {
  $secure = Read-Host $prompt -AsSecureString
  return [Net.NetworkCredential]::new("", $secure).Password.Trim()
}

# Node 20+, npm and git must be there (setup never installs software for you).
function Assert-Tools {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw "Node.js 20 or later is needed: winget install OpenJS.NodeJS.LTS (then open a new PowerShell)" }
  $major = [int](& node -e "console.log(process.versions.node.split('.')[0])")
  if ($major -lt 20) { throw "Node.js $(& node --version) is too old (20 or later is needed): winget upgrade OpenJS.NodeJS.LTS" }
  if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw "npm is needed (it comes with Node.js)" }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "git is needed: winget install Git.Git (then open a new PowerShell)" }
  Write-Host "node $(& node --version), npm $(& npm.cmd --version), $(& git --version)"
  $dockerOk = $false
  if (Get-Command docker -ErrorAction SilentlyContinue) {
    & docker info *> $null
    $dockerOk = ($LASTEXITCODE -eq 0)
  }
  if ($dockerOk) { Write-Host "docker OK" }
  else { Warn "Docker is not installed or not running: 'ask' tasks work, bug hunts and tests need it" }
}

function Get-Cli($root) { return Join-Path $root "apps\node\dist\cli.js" }

# The scheduled task: starts run-node.ps1 when this account logs on, hidden.
function Install-Task($root) {
  $user = "$env:USERDOMAIN\$env:USERNAME"
  $runner = Join-Path $root "run-node.ps1"
  # conhost --headless: with Windows Terminal as the default terminal (Windows 11),
  # -WindowStyle Hidden is ignored and a Terminal window opens anyway.
  $action = New-ScheduledTaskAction -Execute "conhost.exe" `
    -Argument "--headless powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`"" `
    -WorkingDirectory $root
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $trigger.Delay = "PT1M" # lets the network (Tailscale) come up after logon
  # Interactive: runs in the logged-on session (Docker Desktop lives there too).
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  # Killed (not a clean stop, which exits 0): Windows starts it again every minute.
  # The tasks it held come back when their lease runs out.
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "Task '$TaskName' registered for $user (starts 1 min after logon, hidden) and started."
  Write-Host "Logs: $(Join-Path (Get-DataDir) 'logs')"
}

function Stop-Node {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  }
  # The task's process tree can outlive the stop: end any node running this node's CLI.
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*apps\node\dist\cli.js*run*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Start-Node {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Start-ScheduledTask -TaskName $TaskName }
}

function Remove-Task {
  Stop-Node
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
}

# gab-node.cmd in the code folder, and that folder on the user's PATH.
function Install-Command($root) {
  Set-Content -Path (Join-Path $root "gab-node.cmd") -Value "@echo off`r`nnode `"%~dp0apps\node\dist\cli.js`" %*" -Encoding ascii
  $path = [Environment]::GetEnvironmentVariable("Path", "User")
  $entries = @($path -split ';' | Where-Object { $_ })
  if ($entries -notcontains $root) {
    [Environment]::SetEnvironmentVariable("Path", (($entries + $root) -join ';'), "User")
    Write-Host "gab-node command: $root added to your PATH (open a new PowerShell to use it)"
  } else {
    Write-Host "gab-node command in $root"
  }
}

function Remove-Command($root) {
  Remove-Item -Force (Join-Path $root "gab-node.cmd") -ErrorAction SilentlyContinue
  $entries = @([Environment]::GetEnvironmentVariable("Path", "User") -split ';' | Where-Object { $_ -and $_ -ne $root })
  [Environment]::SetEnvironmentVariable("Path", ($entries -join ';'), "User")
}
