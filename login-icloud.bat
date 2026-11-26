@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
chcp 65001 >nul 2>&1
title iCloud Sign-in

rem 日常无需本文件：小组件内「设置 → 打开浏览器登录」即可。
rem 这里提供命令行入口，方便排错。

set "NODE_EXE=%~dp0node\node.exe"
if not exist "%NODE_EXE%" (
  for %%P in (node.exe) do if exist "%%~$PATH:P" set "NODE_EXE=%%~$PATH:P"
)
if not exist "%NODE_EXE%" if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE_EXE%" if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"

if not exist "%NODE_EXE%" (
  echo.
  echo [ERROR] Node.js not found.
  echo         The installer ships its own runtime, please reinstall.
  echo.
  pause
  exit /b 1
)

echo Using Node: !NODE_EXE!
echo.

"!NODE_EXE!" "tools\browser-login.js"

echo.
pause
