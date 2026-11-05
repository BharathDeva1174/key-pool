@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

rem ---------------------------------------------------------------
rem Identity of this checkout. Passed to PowerShell through the
rem environment rather than interpolated into a command string, so a
rem path containing &, ! or spaces cannot break the script.
rem ---------------------------------------------------------------
set "KP_ROOT=%CD%"

set "KP_PORT=%PORT%"
if "%KP_PORT%"=="" set "KP_PORT=20121"
set "KP_HOST=%KEYPOOL_HOST%"
if "%KP_HOST%"=="" set "KP_HOST=127.0.0.1"

echo.
echo  ============================================================
echo     KeyPool  -  OpenAI-compatible pooling proxy
echo  ============================================================
echo.

rem ---------------------------------------------------------------
rem 1. Node must be present
rem ---------------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo  [X] Node.js was not found on your PATH.
  echo      Install Node.js 22.5 or newer from https://nodejs.org/
  echo      then run this file again.
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do set "KP_NODE=%%v"
echo  Node      : !KP_NODE!

rem ---------------------------------------------------------------
rem 2. Pick a package manager (pnpm preferred, npm fallback)
rem ---------------------------------------------------------------
set "KP_PM=npm"
where pnpm >nul 2>&1
if not errorlevel 1 set "KP_PM=pnpm"
echo  Pkg mgr   : !KP_PM!

if not exist "node_modules" (
  echo.
  echo  [1/4] Installing dependencies ^(first run, this takes a while^)...
  if "!KP_PM!"=="pnpm" (
    call pnpm install
  ) else (
    call npm --prefix server install
    if errorlevel 1 goto :fail
    call npm --prefix web install
  )
  if errorlevel 1 goto :fail
) else (
  echo  [1/4] Dependencies already installed.
)

rem ---------------------------------------------------------------
rem 3. Stop any server this checkout already has running
rem
rem  This runs BEFORE the build, and that ordering is the point. A
rem  server started before the current sources existed keeps serving
rem  the build it loaded at boot, so editing code and restarting only
rem  works if the old process is gone first. Identifying it by the
rem  script it is running rather than by port also catches one that
rem  bound a different port - the port is overridable from the
rem  database (see resolveBootSettings), so the number this script
rem  is about to use is not always the number the old one took.
rem
rem  Both ways of running a server from this folder are stopped: the
rem  built one (node server\dist\index.js) and the dev one
rem  (`pnpm dev` -> tsx watch server/src/index.ts), the dev watcher
rem  and the process it spawns to actually serve. Leaving the dev
rem  server up is the same failure by another route - this script
rem  would build, fail to bind the port, and report a start that
rem  never happened, while the old code kept answering.
rem ---------------------------------------------------------------
echo  [2/4] Stopping any running KeyPool from this folder...

rem Output goes through a file rather than a `for /f` loop on purpose. A loop
rem would echo each line back through cmd's parser, so a message containing
rem & or | from an exception would execute as a command. `type` prints the
rem bytes and parses nothing. The file also carries the exit code, which the
rem loop would have discarded - and that code is the only way to learn a prior
rem process refused to die.
set "KP_STOPLOG=%TEMP%\keypool-stop-%RANDOM%.txt"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-keypool.ps1" > "%KP_STOPLOG%" 2>&1
set "KP_STOPRC=%ERRORLEVEL%"
rem `type` and nothing else. A `for /f` loop would put every line back through
rem cmd's parser, so an exception message containing & | > or < would execute as
rem a command; `type` copies the bytes and interprets none of them. Indentation
rem comes from the script's own output rather than from an echo here.
if exist "%KP_STOPLOG%" (
  type "%KP_STOPLOG%"
  del /q "%KP_STOPLOG%" >nul 2>&1
)
rem Nothing printed means nothing was running, which is the normal case.
if not "%KP_STOPRC%"=="0" (
  echo.
  echo  [X] A previous KeyPool could not be stopped ^(exit %KP_STOPRC%^).
  echo      Its code is still what is running, so stopping here would defeat
  echo      the point. Close whatever is holding the port ^(check Task Manager^)
  echo      and run this file again.
  echo.
  pause
  exit /b 1
)

rem ---------------------------------------------------------------
rem 4. Always build
rem
rem  Unconditional on purpose. A staleness check is a guess about
rem  what changed, and the one time it is wrong the running server
rem  silently keeps serving code that is no longer on disk - which
rem  reads as "the fix did not work" rather than "the fix was never
rem  loaded". Building is cheap next to that ambiguity.
rem ---------------------------------------------------------------
echo  [3/4] Building ^(always, so the running code is the code on disk^)...
if "!KP_PM!"=="pnpm" (
  call pnpm build
  if errorlevel 1 goto :fail
) else (
  call npm --prefix server run build
  if errorlevel 1 goto :fail
  call npm --prefix web run build
  if errorlevel 1 goto :fail
)

rem ---------------------------------------------------------------
rem 5. Start
rem ---------------------------------------------------------------
echo  [4/4] Starting KeyPool...
echo.
echo  ------------------------------------------------------------
echo    Dashboard : http://!KP_HOST!:!KP_PORT!/
echo    Base URL  : http://!KP_HOST!:!KP_PORT!/v1
if "%KEYPOOL_DATA_DIR%"=="" (
  echo    Data dir  : .\data
) else (
  echo    Data dir  : %KEYPOOL_DATA_DIR%
)
echo  ------------------------------------------------------------
echo    Your unified API key is printed below on every start.
echo    Press Ctrl+C to stop the server.
echo.

rem Launched by absolute path on purpose. stop-keypool.ps1 identifies a prior
rem instance by the exact file it runs, because a relative "server\dist\
rem index.js" is identical in every Node project and cannot be told apart -
rem see that script for why. A relative launch here would make the next run's
rem stop step blind to the instance this one creates.
node "%KP_ROOT%\server\dist\index.js" --open --port !KP_PORT! --host !KP_HOST!
set "KP_RUNRC=%ERRORLEVEL%"

echo.
rem A non-zero exit here is a server that did not start - a port already in use
rem by something this script could not stop, a bad flag, a failed migration.
rem Reporting that as "Server stopped" reads as a clean shutdown, which is the
rem one thing it is not.
if not "%KP_RUNRC%"=="0" (
  echo  [X] KeyPool exited with code %KP_RUNRC%^). It did not start - scroll up
  echo      for the reason. Nothing is serving on port !KP_PORT! right now.
) else (
  echo  Server stopped.
)
pause
if not "%KP_RUNRC%"=="0" exit /b %KP_RUNRC%
exit /b 0

:fail
echo.
echo  [X] Setup failed. Scroll up for the error output.
echo      Any previously running KeyPool from this folder has been
echo      stopped, so nothing is serving stale code in the meantime.
echo.
pause
exit /b 1
