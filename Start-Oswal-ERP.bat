@echo off
setlocal enabledelayedexpansion
title Oswal Handicrafts ERP
cd /d "%~dp0"

REM ===========================================================================
REM  Oswal Handicrafts ERP - one-tap launcher
REM
REM  Double-click this file. It brings up, in order:
REM    1. dependencies      (only the first time, or after a git pull)
REM    2. the public tunnel (Tailscale Funnel, so the app is reachable anywhere)
REM    3. Postgres          (npm's predev hook starts the in-repo cluster)
REM    4. the API + client  (server on :689, client on :688)
REM
REM  KEEP THIS WINDOW OPEN. Closing it stops the API and the client.
REM  Postgres and the tunnel keep running on purpose - see "Stop-Oswal-ERP.bat".
REM ===========================================================================

REM  Tailscale is reached through PATH rather than by quoted absolute path.
REM  `"%TS%" funnel status | findstr ...` fails with 'C:\Program' is not
REM  recognized: cmd spawns a child for the pipe and loses the quoting around
REM  a path containing a space. Putting the folder on PATH sidesteps it, and
REM  the `where` check below still tells us whether it is installed at all.
set "PATH=%PATH%;C:\Program Files\Tailscale"
set "PUBURL="

echo.
echo  ==========================================================
echo    OSWAL HANDICRAFTS - ERP
echo  ==========================================================
echo.

REM --- Node present? -------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
    echo   [X]  Node.js is not installed, or not on PATH.
    echo.
    echo        Install the LTS build from https://nodejs.org
    echo        then run this file again.
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do set "NODEV=%%v"
echo   [1/4]  Node %NODEV%

REM --- Dependencies --------------------------------------------------------
REM  Checked by folder rather than by a marker file: a half-finished install
REM  leaves node_modules in place, and npm install is safe to re-run anyway.
if not exist "node_modules\" (
    echo   [2/4]  Installing dependencies - first run only, takes a few minutes...
    call npm install
    if errorlevel 1 (
        echo.
        echo   [X]  npm install failed. Read the error above.
        echo.
        pause
        exit /b 1
    )
) else (
    echo   [2/4]  Dependencies present
)

REM --- Public tunnel -------------------------------------------------------
REM  Tailscale runs as a Windows service and the funnel config lives in the
REM  tailnet, so it normally survives a reboot on its own. This re-applies it
REM  only when it is actually off, because turning it on when it already is
REM  costs a round-trip to the control plane for nothing.
where tailscale >nul 2>&1
if errorlevel 1 (
    echo   [3/4]  Tailscale not installed - local access only
) else (
    tailscale funnel status 2>nul | findstr /C:"Funnel on" >nul
    if errorlevel 1 (
        echo   [3/4]  Starting public tunnel...
        tailscale funnel --bg 688 >nul 2>&1
    ) else (
        echo   [3/4]  Public tunnel already up
    )
    for /f "tokens=1" %%u in ('tailscale funnel status 2^>nul ^| findstr /B "https://"') do set "PUBURL=%%u"
    if not defined PUBURL echo          ^(tunnel is not answering - the app still works locally^)
)

REM --- Where to find it ----------------------------------------------------
echo   [4/4]  Starting Postgres, API and client...
echo.
echo  ----------------------------------------------------------
echo    On this laptop     http://localhost:688
if defined PUBURL (
    echo    From anywhere      !PUBURL!
)
REM  Loopback is not an address anybody else can reach, and 100.64/10 is the
REM  CGNAT range Tailscale hands out - printing that as "factory Wi-Fi" sends
REM  somebody on the shop floor to an address only tailnet members can open.
for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr /C:"IPv4 Address"') do (
    set "LANIP=%%i"
    set "LANIP=!LANIP: =!"
    set "SHOWIP=1"
    if "!LANIP:~0,4!"=="127." set "SHOWIP="
    if "!LANIP:~0,4!"=="100." set "SHOWIP="
    if defined SHOWIP echo    On the factory Wi-Fi  http://!LANIP!:688
)
echo  ----------------------------------------------------------
echo.
echo    Keep this window open. Close it to stop the app.
echo.

REM  Open the browser once the client is actually serving, rather than after a
REM  fixed guess: Vite takes longer on a cold start than on a warm one.
start "" /min powershell -NoProfile -WindowStyle Hidden -Command ^
 "$d=[Diagnostics.Stopwatch]::StartNew(); while($d.Elapsed.TotalSeconds -lt 90){ try{ if((Invoke-WebRequest -Uri 'http://localhost:688' -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200){ Start-Process 'http://localhost:688'; break } }catch{}; Start-Sleep -Milliseconds 700 }"

REM  Blocks until stopped. `npm run dev` runs its own predev hook, which starts
REM  the in-repo Postgres cluster before the API tries to connect to it.
call npm run dev

echo.
echo  ----------------------------------------------------------
echo    The API and client have stopped.
echo    Postgres and the tunnel are still running - that is
echo    deliberate, so a restart is quick. Run Stop-Oswal-ERP.bat
echo    to shut those down too.
echo  ----------------------------------------------------------
echo.
pause
