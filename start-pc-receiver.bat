@echo off
setlocal enabledelayedexpansion
title HyperMirror Pro - PC Gaming Screen Mirror Receiver
cd /d "%~dp0pc-receiver"

:: Add standard Node.js, Android SDK ADB, and WinGet FFmpeg locations to PATH for Explorer double-click
set "PATH=%PATH%;C:\Program Files\nodejs;%LOCALAPPDATA%\Programs\nodejs;%APPDATA%\npm;%LOCALAPPDATA%\Android\Sdk\platform-tools;%LOCALAPPDATA%\Microsoft\WinGet\Links"

:: Find node.exe explicitly
set "NODE_EXE=node"
if exist "C:\Program Files\nodejs\node.exe" (
    set "NODE_EXE=C:\Program Files\nodejs\node.exe"
) else if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" (
    set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
) else if exist "%~dp0HyperMirror-PC-Receiver.exe" (
    echo Starting standalone HyperMirror-PC-Receiver.exe ...
    start "" "http://localhost:3080"
    "%~dp0HyperMirror-PC-Receiver.exe"
    pause
    exit /b 0
)

echo ================================================================
echo   Starting HyperMirror Pro PC Receiver on http://localhost:3080
echo   Using Node: "%NODE_EXE%"
echo ================================================================
start "" "http://localhost:3080"
"%NODE_EXE%" server.js
pause
