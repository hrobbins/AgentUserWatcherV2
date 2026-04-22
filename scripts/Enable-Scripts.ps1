# Run this once on any new machine to allow PowerShell scripts to execute.
# Opens an admin prompt automatically.

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process powershell -ArgumentList "-NoExit -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force
Write-Host "Done. PowerShell scripts can now run for this user." -ForegroundColor Green
Read-Host "Press Enter to close"
