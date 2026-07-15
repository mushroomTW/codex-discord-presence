$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataDir = if ([string]::IsNullOrWhiteSpace($env:PLUGIN_DATA)) { $scriptDir } else { $env:PLUGIN_DATA }
$pidPath = Join-Path $dataDir 'codex-discord-presence.pid'

if (-not (Test-Path $pidPath)) {
    Write-Host 'Codex Discord Presence 未在執行。'
    exit 0
}

$pid = [int](Get-Content -Raw $pidPath)
$process = Get-Process -Id $pid -ErrorAction SilentlyContinue
if ($process) {
    Stop-Process -Id $pid
}
Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
Write-Host 'Codex Discord Presence 已停止。'
