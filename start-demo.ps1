param([switch]$RealDiscovery)
$ErrorActionPreference = 'Stop'
$repoDir = $PSScriptRoot
$runtimeDir = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node'
$nodeExe = Join-Path $runtimeDir 'bin\node.exe'
$pnpmCli = Join-Path $runtimeDir 'node_modules\pnpm\bin\pnpm.cjs'
if (!(Test-Path $nodeExe) -or !(Test-Path $pnpmCli)) { throw 'Node.js 24 / pnpm runtime not found.' }
$stateDir = Join-Path $repoDir '.data\local-run'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$stateFile = Join-Path $stateDir 'process.json'
if (Test-Path $stateFile) {
    $previous = Get-Content -Raw $stateFile | ConvertFrom-Json
    $running = Get-CimInstance Win32_Process -Filter "ProcessId=$($previous.processId)"
    if ($running -and $running.CommandLine -like '*demo/run.ts*') {
        if ([bool]$previous.realDiscovery -ne [bool]$RealDiscovery) { throw 'Another mode is running. Stop it with stop-demo.cmd first.' }
        Write-Host 'Already running: http://localhost:3100/login'
        exit 0
    }
}
$env:PATH = (Join-Path $runtimeDir 'bin') + ';' + $env:PATH
$env:npm_execpath = $pnpmCli
$env:SITEOFFER_PYTHON_BIN = (Get-Command python -ErrorAction Stop).Source
$env:NEXT_TELEMETRY_DISABLED = '1'
$env:DEMO_DB_PORT = '15439'
$stdoutFile = Join-Path $stateDir 'stdout.log'
$stderrFile = Join-Path $stateDir 'stderr.log'
$runArgs = @('--import', 'tsx', 'demo/run.ts')
if ($RealDiscovery) { $runArgs += '--real-discovery' }
$demoProcess = Start-Process -FilePath $nodeExe -ArgumentList $runArgs -WorkingDirectory $repoDir -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
@{ processId = $demoProcess.Id; startedAt = (Get-Date).ToString('o'); repo = $repoDir; realDiscovery = [bool]$RealDiscovery } | ConvertTo-Json | Set-Content -Encoding UTF8 $stateFile
Write-Host "Starting SiteOffer (PID $($demoProcess.Id)): http://localhost:3100/login"
Write-Host "Logs: $stateDir"
if ($RealDiscovery) { Write-Host 'Real NTA collection only. Site generation is paused.' } else { Write-Host 'Local mock demo only. Credentials: show-login.cmd' }
