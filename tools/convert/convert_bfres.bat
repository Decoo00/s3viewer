@echo off
rem bfres.zs 파일을 이 파일 위로 끌어다 놓거나, 더블클릭해서 파일 선택 창으로 고른다.
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0convert.ps1" %*
pause
