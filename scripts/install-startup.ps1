$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$startScript = Join-Path $scriptDir 'start.ps1'
$config = Get-Content -Raw (Join-Path $scriptDir 'config.json') | ConvertFrom-Json

if ([string]::IsNullOrWhiteSpace($config.clientId)) {
    throw '請先在 scripts\config.json 填入 Discord Application ID（clientId）。'
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
Register-ScheduledTask -TaskName 'Codex Discord Presence' -Action $action -Trigger $trigger -Description '在登入時啟動 Codex Discord Rich Presence。' -Force | Out-Null
Write-Host '已設定登入 Windows 時自動啟動 Codex Discord Presence。'
