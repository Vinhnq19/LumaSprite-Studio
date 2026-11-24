@echo off
echo ===================================================
echo     Khoi dong LumaSprite PXL Live Viewer
echo ===================================================
cd /d "%~dp0"
echo Dang mo trinh duyet tai http://127.0.0.1:4321/ ...
start "" "http://127.0.0.1:4321/"
set "ART=test_art.px.js"
if not exist "%ART%" set "ART=examples\basics.px.js"
node bin/pxl.js serve "%ART%"
pause
