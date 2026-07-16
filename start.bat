@echo off
chcp 65001 > nul
title Family Fund Manager Launcher v2.2

node -v >nul 2>&1
if errorlevel 1 goto NO_NODE

if not exist node_modules goto INSTALL_DEPS

:RUN
echo [System] Starting server and opening browser...
start /b cmd /c "timeout /t 2 >nul && start http://localhost:3000"
npm start
pause

:INSTALL_DEPS
echo [System] Installing dependencies, please wait...
call npm install
if errorlevel 1 goto INSTALL_FAIL
goto RUN

:NO_NODE
echo [Error] Node.js is not installed!
echo Please download and install Node.js from https://nodejs.org/
pause
exit

:INSTALL_FAIL
echo [Error] Failed to install dependencies. Please check your network.
pause
exit
