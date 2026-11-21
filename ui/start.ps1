# ODE-cloud Web UI launcher (PowerShell).
# ASCII-only console output avoids cmd/PowerShell code-page mojibake.
# Usage:
#   .\start.ps1
#   .\start.ps1 --port 8790
#   powershell -ExecutionPolicy Bypass -File .\start.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $root

Write-Host ''
Write-Host '  ODE-cloud Web UI'
Write-Host '  ----------------'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host ''
    Write-Host '  [ERROR] Node.js was not found.' -ForegroundColor Red
    Write-Host '  Install Node.js 22 or newer: https://nodejs.org/'
    Write-Host ''
    exit 1
}

$server = Join-Path $root 'server.mjs'
if (-not (Test-Path -LiteralPath $server)) {
    Write-Host ''
    Write-Host '  [ERROR] server.mjs was not found next to start.ps1.' -ForegroundColor Red
    Write-Host ''
    exit 1
}

Write-Host '  Starting the local server...'
Write-Host '  The browser will open automatically.'
Write-Host '  Press Ctrl+C to stop.'
Write-Host ''

& node $server --open @args
$code = $LASTEXITCODE
if ($code -ne 0) {
    Write-Host ''
    Write-Host "  Server exited with code $code." -ForegroundColor Yellow
    Write-Host '  If the port is busy, try: .\start.ps1 --port 8790'
    Write-Host ''
}
exit $code