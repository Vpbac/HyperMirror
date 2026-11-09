@echo off
setlocal enabledelayedexpansion
title HyperMirror Pro - PC Gaming Screen Mirror Receiver
cd /d "%~dp0pc-receiver"

:: Add standard Node.js, Android SDK ADB, and WinGet FFmpeg locations to PATH
set "PATH=%PATH%;C:\Program Files\nodejs;%LOCALAPPDATA%\Programs\nodejs;%APPDATA%\npm;%LOCALAPPDATA%\Android\Sdk\platform-tools;%LOCALAPPDATA%\Microsoft\WinGet\Links"

:: Free port 3080 or 27183 if held by an old background instance
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3080 :27183" ^| findstr "LISTENING"') do (
    if not "%%a"=="0" taskkill /F /PID %%a /T >nul 2>&1
)

:: Find node.exe explicitly
set "NODE_EXE=node"
if exist "C:\Program Files\nodejs\node.exe" (
    set "NODE_EXE=C:\Program Files\nodejs\node.exe"
) else if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" (
    set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
)

echo ================================================================
echo   Starting HyperMirror Pro PC Receiver on http://localhost:3080
echo ================================================================
start "" "http://localhost:3080"
"%NODE_EXE%" server.js
pause
