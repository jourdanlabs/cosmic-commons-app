@echo off
cd /d "%~dp0"
node scripts/doctor.mjs
if errorlevel 1 goto done
start "COMMONS browser" cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:4320"
node server.mjs
:done
pause
