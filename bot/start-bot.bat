@echo off
rem Starts the WhatsApp bot. Put a shortcut to this file in the Windows Startup
rem folder (Win+R, type shell:startup) to launch it whenever you log in.
cd /d "%~dp0"
if not exist data mkdir data
:loop
node bot.js >> data\bot.log 2>&1
rem If the bot exits (crash, network problem), wait 10 seconds and start it again.
timeout /t 10 /nobreak >nul
goto loop
