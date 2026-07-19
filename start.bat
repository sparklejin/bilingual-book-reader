@echo off
chcp 65001 >nul
echo ========================================
echo   📖 Bilingual Book Reader
echo   英文电子书双语辅助阅读器
echo ========================================
echo.
echo 🚀 正在启动...
cd /d "%~dp0"
call npm start
pause
