@echo off
chcp 65001 >nul 2>&1
rem ============================================================
rem  提醒事项小组件 · 启动
rem  优先启动原生宿主（无控制台窗口），未编译时回退浏览器窗口
rem ============================================================
setlocal
set "DIR=%~dp0"
set "URL=http://127.0.0.1:8642/"

if exist "%DIR%host\RemindersWidget.exe" (
  start "" "%DIR%host\RemindersWidget.exe"
  exit /b 0
)

rem ---------- 回退方案：找 node，隐藏窗口起服务，再用 Edge 应用窗口打开 ----------
set "NODE=%DIR%node\node.exe"
if not exist "%NODE%" (
  for %%P in (node.exe) do if exist "%%~$PATH:P" set "NODE=%%~$PATH:P"
)
if not exist "%NODE%" if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE%" if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"

if not exist "%NODE%" (
  echo [错误] 未找到 Node.js。安装版已自带运行时，请用安装程序重新安装。
  pause
  exit /b 1
)

powershell -NoProfile -Command "try{ $c=New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',8642); $c.Close(); exit 0 }catch{ exit 1 }"
if errorlevel 1 (
  powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath '%NODE%' -ArgumentList '\"%DIR%server.js\"' -WorkingDirectory '%DIR%' -WindowStyle Hidden"
  timeout /t 2 /nobreak >nul
)

set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" (
  start "" "%EDGE%" --app=%URL% --window-size=420,760
) else (
  start "" %URL%
)
