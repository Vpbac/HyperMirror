@echo off
title HyperMirror Pro - USB Cable ADB Tunnel
set "ADB_EXE=%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe"
if not exist "%ADB_EXE%" set "ADB_EXE=adb"

echo [HyperMirror Pro] Setting up Zero-Latency USB Cable Tunnel...
"%ADB_EXE%" devices
"%ADB_EXE%" forward tcp:27184 tcp:27183
"%ADB_EXE%" reverse tcp:27183 tcp:27183
echo.
echo Done! You can now stream over USB with ~10ms latency.
pause
