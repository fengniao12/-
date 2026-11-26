@echo off
chcp 936 >nul
cd /d "%~dp0"
set SSH_PASS=
set PYTHONIOENCODING=utf-8
python tools\ssh_tunnel.py
pause
