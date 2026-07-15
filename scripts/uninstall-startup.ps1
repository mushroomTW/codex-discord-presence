$task = Get-ScheduledTask -TaskName 'Codex Discord Presence' -ErrorAction SilentlyContinue
if ($task) {
    Unregister-ScheduledTask -TaskName 'Codex Discord Presence' -Confirm:$false
    Write-Host '已移除 Codex Discord Presence 的自動啟動。'
} else {
    Write-Host '未找到 Codex Discord Presence 的自動啟動工作。'
}
