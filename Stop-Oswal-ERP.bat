@echo off
setlocal enabledelayedexpansion
title Stop Oswal ERP
cd /d "%~dp0"

REM ===========================================================================
REM  Shuts down everything the launcher started: the client, the API, the
REM  public tunnel, and the Postgres cluster.
REM
REM  Postgres is stopped LAST and CLEANLY. A clean stop is what makes the data
REM  directory copyable - `npm run db:backup` refuses to copy a running cluster
REM  because a torn snapshot may not start at all.
REM ===========================================================================

set "TS=C:\Program Files\Tailscale\tailscale.exe"

echo.
echo  ==========================================================
echo    STOPPING OSWAL HANDICRAFTS - ERP
echo  ==========================================================
echo.

REM --- Client and API ------------------------------------------------------
REM  Killed by the PORT they hold rather than by process name: `taskkill /im
REM  node.exe` would take down every other Node process on the machine.
for %%P in (688 689) do (
    set "FOUND="
    for /f "tokens=5" %%A in ('netstat -ano ^| findstr /R /C:":%%P .*LISTENING"') do (
        if not "%%A"=="0" (
            taskkill /PID %%A /F >nul 2>&1
            set "FOUND=1"
        )
    )
    if defined FOUND (
        echo   [+]  Stopped whatever was listening on %%P
    ) else (
        echo   [-]  Nothing was listening on %%P
    )
)

REM --- Public tunnel -------------------------------------------------------
if exist "%TS%" (
    "%TS%" funnel status 2>nul | findstr /C:"Funnel on" >nul
    if errorlevel 1 (
        echo   [-]  Public tunnel was not running
    ) else (
        "%TS%" funnel --https=443 off >nul 2>&1
        echo   [+]  Public tunnel switched off
    )
) else (
    echo   [-]  Tailscale not installed
)

REM --- Postgres ------------------------------------------------------------
echo   [+]  Stopping Postgres cleanly...
call npm run pg:stop

echo.
echo  ----------------------------------------------------------
echo    Everything is stopped.
echo    Start it again with "Start-Oswal-ERP.bat".
echo  ----------------------------------------------------------
echo.
pause
