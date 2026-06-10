@echo off
chcp 65001 >nul
echo ============================================
echo   Mew Social - Windows Installer
echo ============================================
echo.

:: Check admin
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [ERROR] กรุณารันไฟล์นี้ในฐานะ Administrator
    echo คลิกขวา install-windows.bat แล้วเลือก "Run as administrator"
    pause
    exit /b 1
)

set APP_DIR=%~dp0

:: ── 1. Check Node.js ──
echo [1/5] ตรวจสอบ Node.js...
node --version >nul 2>&1
if %errorLevel% neq 0 (
    echo Node.js ไม่พบ กำลัง download...
    curl -L "https://nodejs.org/dist/v20.11.0/node-v20.11.0-x64.msi" -o "%TEMP%\node-installer.msi"
    msiexec /i "%TEMP%\node-installer.msi" /quiet /norestart
    echo Node.js ติดตั้งเสร็จ
) else (
    echo Node.js พบแล้ว:
    node --version
)

:: ── 2. Check Python ──
echo.
echo [2/5] ตรวจสอบ Python...
python --version >nul 2>&1
if %errorLevel% neq 0 (
    echo Python ไม่พบ กำลัง download...
    curl -L "https://www.python.org/ftp/python/3.10.11/python-3.10.11-amd64.exe" -o "%TEMP%\python-installer.exe"
    "%TEMP%\python-installer.exe" /quiet InstallAllUsers=1 PrependPath=1
    echo Python ติดตั้งเสร็จ
) else (
    echo Python พบแล้ว:
    python --version
)

:: ── 3. Check ffmpeg ──
echo.
echo [3/5] ตรวจสอบ ffmpeg...
ffmpeg -version >nul 2>&1
if %errorLevel% neq 0 (
    echo ffmpeg ไม่พบ กำลัง download...
    curl -L "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip" -o "%TEMP%\ffmpeg.zip"
    powershell -Command "Expand-Archive '%TEMP%\ffmpeg.zip' '%ProgramFiles%\ffmpeg' -Force"
    setx /M PATH "%PATH%;%ProgramFiles%\ffmpeg\ffmpeg-master-latest-win64-gpl\bin"
    echo ffmpeg ติดตั้งเสร็จ
) else (
    echo ffmpeg พบแล้ว
)

:: ── 4. Install Node dependencies ──
echo.
echo [4/5] ติดตั้ง Node.js dependencies...
cd /d "%APP_DIR%"
call npm install
if %errorLevel% neq 0 (
    echo [ERROR] npm install ล้มเหลว
    pause
    exit /b 1
)

:: ── 5. Install Whisper ──
echo.
echo [5/5] ติดตั้ง Whisper (อาจใช้เวลา 5-10 นาที)...
pip install openai-whisper >nul 2>&1
echo Whisper ติดตั้งเสร็จ

:: ── Setup .env.local ──
echo.
echo ============================================
echo   ตั้งค่า Environment
echo ============================================
if not exist "%APP_DIR%.env.local" (
    echo กำลังสร้างไฟล์ .env.local...
    (
        echo DATABASE_URL="file:./dev.db"
        echo NEXTAUTH_SECRET="%RANDOM%%RANDOM%%RANDOM%%RANDOM%"
        echo NEXTAUTH_URL="http://localhost:3000"
        echo WHISPER_MODEL=medium
    ) > "%APP_DIR%.env.local"
    echo ไฟล์ .env.local สร้างแล้ว
) else (
    echo ไฟล์ .env.local มีอยู่แล้ว
)

:: ── Setup Database ──
echo.
echo กำลังสร้างฐานข้อมูล...
call npx prisma generate
call npx prisma db push
if %errorLevel% neq 0 (
    echo [ERROR] สร้างฐานข้อมูลล้มเหลว
    pause
    exit /b 1
)

:: ── Build App ──
echo.
echo กำลัง build แอป (อาจใช้เวลา 3-5 นาที)...
call npm run build
if %errorLevel% neq 0 (
    echo [ERROR] build ล้มเหลว
    pause
    exit /b 1
)

:: ── Create start shortcut ──
echo.
echo สร้าง shortcut เปิดแอป...
(
    echo @echo off
    echo cd /d "%APP_DIR%"
    echo start "" "http://localhost:3000"
    echo npm start
) > "%APP_DIR%start.bat"

:: ── Create desktop shortcut ──
powershell -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\Mew Social.lnk'); $s.TargetPath = '%APP_DIR%start.bat'; $s.WorkingDirectory = '%APP_DIR%'; $s.IconLocation = '%SystemRoot%\System32\shell32.dll,14'; $s.Save()"

echo.
echo ============================================
echo   ติดตั้งเสร็จเรียบร้อย!
echo ============================================
echo.
echo กด double-click "Mew Social" บน Desktop เพื่อเปิดแอป
echo หรือรัน start.bat ในโฟลเดอร์นี้
echo.
echo แอปจะเปิดที่: http://localhost:3000
echo.
pause
