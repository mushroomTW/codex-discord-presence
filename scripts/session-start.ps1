$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataDir = if ([string]::IsNullOrWhiteSpace($env:PLUGIN_DATA)) { $scriptDir } else { $env:PLUGIN_DATA }
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

try {
    $event = ($input | Out-String | ConvertFrom-Json)
    $cwd = [string]$event.cwd
    if (-not [string]::IsNullOrWhiteSpace($cwd)) {
        @{ projectName = (Split-Path -Leaf $cwd) } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $dataDir 'active-project.json') -Encoding utf8
    }
} catch {
    # The presence service can fall back to session history when hook input is unavailable.
}

& (Join-Path $scriptDir 'start.ps1')
