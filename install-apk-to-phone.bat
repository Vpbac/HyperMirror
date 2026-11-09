@echo off
title HyperMirror Pro - Install APK to Android Phone
set "ADB_EXE=%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe"
if not exist "%ADB_EXE%" set "ADB_EXE=adb"

set "APK_PATH=%~dp0HyperMirrorSender-debug.apk"
if not exist "%APK_PATH%" (
    set "APK_PATH=%~dp0android-sender\app\build\outputs\apk\debug\app-debug.apk"
)

echo ================================================================
echo   HYPERMIRROR PRO - APK INSTALLER
echo ================================================================
echo Checking connected Android devices...
"%ADB_EXE%" devices
echo.
echo Installing "%APK_PATH%" to your Android device...
"%ADB_EXE%" install -r "%APK_PATH%"
echo.
echo Setting up USB Low-Latency Tunnel...
"%ADB_EXE%" forward tcp:27184 tcp:27183
"%ADB_EXE%" reverse tcp:27183 tcp:27183
echo.
echo Done! Open "HyperMirror Pro" on your phone to start mirroring.
pause
