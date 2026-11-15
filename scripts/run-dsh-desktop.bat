@echo off
setlocal

REM dsh desktop launcher (ASCII only - cmd cannot parse UTF-8 Chinese here)
REM Data root: C:\dsh-lab\tmp\wx-real-root  (real WeChat data, 151886 messages)
REM To use production root, change KNOWSELF_ROOT_DIR to the knowSelf project dir.

set "DSH_HOME=C:\Users\40179\.dsh"
set "KNOWSELF_ROOT_DIR=C:\Users\40179\Documents\AllProjecks\knowSelf"
set "DSH_DESKTOP_PRIMARY_RUNTIME_DIR=C:\dsh-lab\_deepseek-harness\apps\desktop\.desktop-build\targets\win-x64\runtime\primary-runtime"
set "NODE_OPTIONS="
set "ELECTRON_RUN_AS_NODE="

set "APP=C:\dsh-lab\_deepseek-harness\apps\desktop"
set "EXE=%APP%\node_modules\electron\dist\electron.exe"
set "UD=%APP%\.desktop-build\development\electron-user-data"

if not exist "%EXE%" (
  echo [ERROR] electron.exe not found:
  echo   %EXE%
  pause
  exit /b 1
)

echo ============================================================
echo  Starting dsh desktop
echo  Data root: %KNOWSELF_ROOT_DIR%
echo  First start takes 90-120 seconds. Keep this window open.
echo  Closing this window stops the app.
echo ============================================================
echo.

cd /d "%APP%"
"%EXE%" --remote-debugging-port=9222 --user-data-dir="%UD%" "%APP%"

echo.
echo App exited.
pause
