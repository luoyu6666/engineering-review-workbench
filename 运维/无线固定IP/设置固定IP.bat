@echo off
rem One-click: set the Wi-Fi adapter to a fixed IP (all logic lives in net-ip-set.ps1)
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0'"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0net-ip-set.ps1" -Fix