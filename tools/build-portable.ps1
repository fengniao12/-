# 生成绿色版（免安装）目录 dist\语音工坊
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'node_modules\electron\dist'
$out = Join-Path $root 'dist\语音工坊'

if (-not (Test-Path $src)) {
  throw "未找到 Electron 运行时：$src`n请先执行 npm install 和 node node_modules/electron/install.js"
}

if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $out | Out-Null

Write-Host "复制 Electron 运行时..."
Copy-Item (Join-Path $src '*') $out -Recurse -Force

$app = Join-Path $out 'resources\app'
New-Item -ItemType Directory -Path $app | Out-Null
foreach ($f in 'package.json', 'main.js', 'preload.js') {
  Copy-Item (Join-Path $root $f) (Join-Path $app $f) -Force
}
foreach ($d in 'lib', 'renderer', 'assets') {
  Copy-Item (Join-Path $root $d) (Join-Path $app $d) -Recurse -Force
}

$defaultApp = Join-Path $out 'resources\default_app.asar'
if (Test-Path $defaultApp) { Remove-Item $defaultApp -Force }

Rename-Item (Join-Path $out 'electron.exe') '语音工坊.exe'
Write-Host "已生成：$out"
Write-Host "双击其中的 语音工坊.exe 启动。"
