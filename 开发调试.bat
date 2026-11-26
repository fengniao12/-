@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
start "" "node_modules\electron\dist\electron.exe" . --devtools
