@echo off
title LumaSprite Studio
setlocal DisableDelayedExpansion
cd /d "%~dp0" || exit /b 1
if defined LUMASPRITE_NODE goto :check_override

for /f "delims=" %%N in ('where node.exe 2^>nul') do (
  call :compatible "%%N"
  if not errorlevel 1 (
    set "LUMASPRITE_NODE=%%N"
    goto :run
  )
)
goto :unsupported

:check_override
call :compatible "%LUMASPRITE_NODE%"
if errorlevel 1 goto :unsupported

:run
"%LUMASPRITE_NODE%" scripts\launch-studio.js %*
set "result=%errorlevel%"
if not "%result%"=="0" if not defined CI pause
exit /b %result%

:unsupported
echo Can Node.js 22.18 tro len. Kiem tra PATH hoac LUMASPRITE_NODE.
if not defined CI pause
exit /b 1

:compatible
"%~1" -e "const [m,n]=process.versions.node.split('.').map(Number); process.exit(m>22||m===22&&n>=18?0:1)" >nul 2>nul
exit /b %errorlevel%
