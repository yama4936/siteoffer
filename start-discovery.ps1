$ErrorActionPreference = 'Stop'
$nodeExe = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
Push-Location $PSScriptRoot
try {
    & $nodeExe --env-file-if-exists=.env -e 'process.exit(process.env.NTA_APPLICATION_ID?.trim() ? 0 : 2)'
    if ($LASTEXITCODE -ne 0) { throw 'Set NTA_APPLICATION_ID in .env first. The running demo has not been stopped.' }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'stop-demo.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'Could not stop the current process.' }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'start-demo.ps1') -RealDiscovery
    if ($LASTEXITCODE -ne 0) { throw 'Could not start real discovery.' }
} finally { Pop-Location }
