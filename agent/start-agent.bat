@echo off
title LogInTo Agent
color 0B

echo.
echo  =============================================
echo    LogInTo Agent - Starting...
echo  =============================================
echo.

:: Check .env
if not exist .env (
    echo  [!] No .env file found!
    echo  Run install-windows.bat first, then edit .env with your AGENT_KEY.
    echo.
    pause
    exit /b 1
)

:: Run the agent
node agent.js

:: If it exits, pause so user can see errors
echo.
echo  Agent stopped. Press any key to close.
pause >nul
