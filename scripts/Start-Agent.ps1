# AgentUserWatcher - Monitoring Agent
# Run this as Administrator -- screen capture requires admin rights

param()

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

# Self-elevate if not already admin
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "Requesting administrator privileges..."
    Start-Process powershell -ArgumentList "-NoExit -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

$Host.UI.RawUI.WindowTitle = "AgentUserWatcher - Agent"
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  AgentUserWatcher - Monitoring Agent" -ForegroundColor Cyan
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

Write-Host "Starting agent (polls every 60s, enforcement mode: $(node -e "console.log(require('./config/agent.json').enforcement.mode)"))..." -ForegroundColor Green
Write-Host "Press Ctrl+C to stop."
Write-Host ""

node src/agent/index.js

Write-Host ""
Write-Host "Agent exited." -ForegroundColor Yellow
Read-Host "Press Enter to close"
