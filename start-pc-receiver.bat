@echo off
setlocal enabledelayedexpansion
title HyperMirror Pro - PC Gaming Screen Mirror Receiver
cd /d "%~dp0pc-receiver"

:: 1. Add standard Node.js, Android SDK ADB, and WinGet FFmpeg locations to PATH
set "PATH=%PATH%;C:\Program Files\nodejs;%LOCALAPPDATA%\Programs\nodejs;%APPDATA%\npm;C:\Program Files (x86)\nodejs;%NVM_HOME%;%LOCALAPPDATA%\Android\Sdk\platform-tools;%LOCALAPPDATA%\Microsoft\WinGet\Links"

:: 2. Find node.exe explicitly across common installation paths
set "NODE_EXE="
if exist "C:\Program Files\nodejs\node.exe" (
    set "NODE_EXE=C:\Program Files\nodejs\node.exe"
) else if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" (
    set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
) else if exist "C:\Program Files (x86)\nodejs\node.exe" (
    set "NODE_EXE=C:\Program Files (x86)\nodejs\node.exe"
) else if exist "%APPDATA%\npm\node.exe" (
    set "NODE_EXE=%APPDATA%\npm\node.exe"
) else (
    where node.exe >nul 2>&1
    if not errorlevel 1 set "NODE_EXE=node"
)

:: 3. If Node.js is not found, prompt or auto-install
if defined NODE_EXE goto :NODE_READY

echo ================================================================
echo   [THONG BAO] May tinh cua ban chua cai dat Node.js
echo ================================================================
echo   PC Receiver can Node.js de khoi chay may chu sieu toc do.
echo.
where winget.exe >nul 2>&1
if not errorlevel 1 (
    echo   Phat hien Windows Winget! Dang tu dong cai dat Node.js LTS...
    winget install OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
    if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
)

if defined NODE_EXE goto :NODE_READY

echo   Dang mo trinh duyet den trang chu Node.js de tai ve...
start "" "https://nodejs.org/en/download"
echo.
echo   Vui long cai dat Node.js ban LTS, sau do mo lai file bat nay!
echo ================================================================
pause
exit /b 1

:NODE_READY
:: 4. Add Windows Firewall exception for Wi-Fi Direct streaming
netsh advfirewall firewall show rule name="HyperMirror Pro Receiver" >nul 2>&1
if errorlevel 1 (
    netsh advfirewall firewall add rule name="HyperMirror Pro Receiver" dir=in action=allow protocol=TCP localport=3080,27183,27184 profile=any >nul 2>&1
    netsh advfirewall firewall add rule name="HyperMirror Pro UDP Discovery" dir=in action=allow protocol=UDP localport=27185 profile=any >nul 2>&1
)

:: 5. Free port 3080 or 27183/27184 if held by an orphaned instance
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3080 :27183 :27184" ^| findstr "LISTENING"') do (
    if not "%%a"=="0" taskkill /F /PID %%a /T >nul 2>&1
)

echo ================================================================
echo   Dang khoi chay HyperMirror Pro PC Receiver...
echo   Trinh duyet se tu dong mo http://localhost:3080 khi san sang!
echo ================================================================

"%NODE_EXE%" server.js
pause
