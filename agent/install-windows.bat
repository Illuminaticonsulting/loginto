@echo off
title LogInTo Agent - Windows Setup
color 0A

echo.
echo  =============================================
echo    LogInTo Agent - Windows Setup
echo  =============================================
echo.

:: Check if Node.js is installed
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo  [!] Node.js is NOT installed.
    echo.
    echo  Please install Node.js first:
    echo    https://nodejs.org/en/download
    echo.
    echo  Download the "Windows Installer (.msi)" and run it.
    echo  Then run this script again.
    echo.
    pause
    exit /b 1
)

:: Show Node version
for /f "tokens=*" %%i in ('node -v') do set NODE_VERSION=%%i
echo  [OK] Node.js %NODE_VERSION% found
echo.

:: Install dependencies (skip robotjs if it fails — we have PowerShell fallback)
echo  Installing dependencies...
echo.
call npm install --no-optional 2>nul
if %ERRORLEVEL% neq 0 (
    echo.
    echo  [!] npm install had issues. Trying without optional deps...
    call npm install dotenv screenshot-desktop sharp socket.io-client
)

echo.
echo  [OK] Dependencies installed
echo.

:: Try to install robotjs (optional — will fail gracefully)
echo  Attempting to install robotjs (optional, for faster input)...
call npm install robotjs 2>nul
if %ERRORLEVEL% neq 0 (
    echo  [i] robotjs skipped - using PowerShell fallback for input
    echo      (This works fine, just slightly slower)
) else (
    echo  [OK] robotjs installed
)

echo.
echo  =============================================
echo    Setup complete!
echo  =============================================
echo.

:: Check if .env exists
if not exist .env (
    echo  [!] You need to create a .env file.
    echo.
    echo  1. Log into: https://loginto.kingpinstrategies.com
    echo  2. Copy your Agent Key from the dashboard
    echo  3. Copy .env.example to .env and paste your key
    echo.
    copy .env.example .env >nul 2>&1
    echo  A .env file has been created from the example.
    echo  Edit it with Notepad and paste your AGENT_KEY:
    echo.
    echo     notepad .env
    echo.
) else (
    echo  [OK] .env file found
)

echo.
echo  To start the agent, run:
echo     start-agent.bat
echo  or:
echo     npm start
echo.
pause
