@echo off
rem One-click: switch the Wi-Fi adapter back to DHCP (for travel / home use)
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0'"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0net-ip-set.ps1" -Auto