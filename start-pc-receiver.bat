@echo off
title HyperMirror Pro - PC Gaming Screen Mirror Receiver
cd /d "%~dp0pc-receiver"
echo Starting HyperMirror Pro PC Receiver on http://localhost:3080 ...
start "" "http://localhost:3080"
node server.js
pause
