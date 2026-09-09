@echo off
chcp 65001 >nul
title Solar Sizing Tool - Local Server
cd /d "%~dp0"

echo ============================================================
echo  เริ่มเซิร์ฟเวอร์ท้องถิ่น (offline) ที่ http://127.0.0.1:8765
echo
echo  หน้าแอพ : http://127.0.0.1:8765/PEA-Solar-Sizing-Tool/index.html
echo  หน้าทดสอบ : http://127.0.0.1:8765/PEA-Solar-Sizing-Tool/__tests__/e2e.html
echo
echo  ปิดหน้าต่างนี้เพื่อหยุดเซิร์ฟเวอร์
echo ============================================================
echo.

start "" "http://127.0.0.1:8765/PEA-Solar-Sizing-Tool/index.html"

where python >nul 2>nul
if %errorlevel%==0 (
    python -m http.server 8765 --bind 127.0.0.1 --directory "%USERPROFILE%"
) else (
    echo ไม่พบ python ใน PATH - เปิดผ่าน C:\Python314\python.exe
    "C:\Python314\python.exe" -m http.server 8765 --bind 127.0.0.1 --directory "%USERPROFILE%"
)

pause