@echo off
rem ============================================================
rem  重新编译小组件宿主（仅需一次；需要 .NET SDK）
rem  产物：host\RemindersWidget.exe
rem ============================================================
set "DIR=%~dp0"
where dotnet >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 dotnet SDK，无法重新编译。已编译版本可直接运行 host\RemindersWidget.exe
  pause
  exit /b 1
)
dotnet build "%DIR%host\WidgetHost.csproj" -c Release
if errorlevel 1 (
  echo [编译失败]
  pause
  exit /b 1
)
copy /y "%DIR%host\bin\Release\RemindersWidget.exe" "%DIR%host\RemindersWidget.exe" >nul
echo [完成] host\RemindersWidget.exe 已更新
pause
