$ErrorActionPreference = 'Stop'
$stateFile = Join-Path $PSScriptRoot '.data\local-run\process.json'
if (!(Test-Path $stateFile)) { Write-Host 'No recorded demo process.'; exit 0 }
$state = Get-Content -Raw $stateFile | ConvertFrom-Json
$running = Get-CimInstance Win32_Process -Filter "ProcessId=$($state.processId)"
if (!$running) { Write-Host 'Already stopped.'; exit 0 }
if ($state.repo -ne $PSScriptRoot -or $running.CommandLine -notlike '*demo/run.ts*') { throw 'Process identity does not match; no process was stopped.' }
& taskkill.exe /PID $state.processId /T /F
if ($LASTEXITCODE -ne 0 -and (Get-CimInstance Win32_Process -Filter "ProcessId=$($state.processId)")) { throw 'Stopping the demo failed.' }
Write-Host 'SiteOffer stopped. Demo data is retained.'
