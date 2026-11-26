@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="

if not exist "node_modules\electron\dist\electron.exe" (
  echo 首次启动，正在准备 Electron 运行时...
  if not exist "node_modules\electron\package.json" call npm install --no-audit --no-fund
  if not exist "node_modules\electron\dist\electron.exe" (
    set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
    call node "node_modules\electron\install.js"
  )
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo.
  echo Electron 运行时不完整，请确认已安装 Node.js 20+ 且网络可用。
  echo 然后重新双击本脚本，或在项目目录手工执行：
  echo   set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  echo   node node_modules/electron/install.js
  echo.
  pause
  exit /b 1
)

start "" "node_modules\electron\dist\electron.exe" .
