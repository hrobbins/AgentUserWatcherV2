# AgentUserWatcher - Start Everything
# Opens the server and agent in separate admin PowerShell windows.

param()

$root = Split-Path $PSScriptRoot -Parent

# Self-elevate if not already admin (needed to launch child windows as admin)
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "Requesting administrator privileges..."
    Start-Process powershell -ArgumentList "-NoExit -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

# Install dependencies first if needed
Set-Location $root
if (-not (Test-Path "$root\node_modules")) {
    Write-Host "Installing dependencies..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "npm install failed." -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
    Write-Host "Done." -ForegroundColor Green
}

Write-Host ""
Write-Host "Starting server and agent in separate windows..." -ForegroundColor Cyan

# Launch server in a new window (already admin since we're elevated)
Start-Process powershell -ArgumentList "-NoExit -ExecutionPolicy Bypass -File `"$PSScriptRoot\Start-Server.ps1`""

# Small delay so server binds its port before agent tries to report
Start-Sleep -Seconds 2

# Launch agent in a new window
Start-Process powershell -ArgumentList "-NoExit -ExecutionPolicy Bypass -File `"$PSScriptRoot\Start-Agent.ps1`""

Write-Host "Both processes launched." -ForegroundColor Green
Write-Host "Close their windows individually to stop them."
Write-Host ""
Read-Host "Press Enter to close this launcher"
