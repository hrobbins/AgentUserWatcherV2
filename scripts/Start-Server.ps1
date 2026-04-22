# AgentUserWatcher — Dashboard Server
# Run this as Administrator (script will self-elevate if needed)

param()

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

# Self-elevate if not already admin
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "Requesting administrator privileges..."
    Start-Process powershell -ArgumentList "-NoExit -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

$Host.UI.RawUI.WindowTitle = "AgentUserWatcher — Server"
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  AgentUserWatcher — Dashboard Server" -ForegroundColor Cyan
Write-Host "  http://localhost:4000" -ForegroundColor Cyan
Write-Host "============================================================"
Write-Host ""

Set-Location $root

if (-not (Test-Path "$root\node_modules")) {
    Write-Host "Installing dependencies..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "npm install failed." -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
}

Write-Host "Starting server..." -ForegroundColor Green
node src/server/index.js

Write-Host ""
Write-Host "Server exited." -ForegroundColor Yellow
Read-Host "Press Enter to close"
