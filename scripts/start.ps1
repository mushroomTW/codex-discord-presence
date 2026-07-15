$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = Get-Command node -ErrorAction Stop
$config = Get-Content -Raw (Join-Path $scriptDir 'config.json') | ConvertFrom-Json

if ([string]::IsNullOrWhiteSpace($config.clientId)) {
    throw 'Discord Application ID is missing in scripts\config.json.'
}

$dataDir = if ([string]::IsNullOrWhiteSpace($env:PLUGIN_DATA)) { $scriptDir } else { $env:PLUGIN_DATA }
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$pidPath = Join-Path $dataDir 'codex-discord-presence.pid'
if (Test-Path $pidPath) {
    $oldPid = [int](Get-Content -Raw $pidPath)
    if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) {
        Write-Host 'Codex Discord Presence is already running.'
        exit 0
    }
    Remove-Item -LiteralPath $pidPath -Force
}

$script = Join-Path $scriptDir 'codex-discord-presence.js'
Start-Process -FilePath $node.Source -ArgumentList @($script) -WorkingDirectory $scriptDir -WindowStyle Hidden
Write-Host 'Codex Discord Presence started.'
