@echo off
chcp 65001 >nul
setlocal
REM ============================================================
REM  Ryken Mobile 手机端上位机 — 一键编译 APK
REM  ─────────────────────────────────────────────────────────
REM  换机器 / 换目录只要两步：
REM    1) 装 JDK 17，设 JAVA_HOME
REM    2) 装 Android SDK，设 ANDROID_HOME
REM  Gradle 由工程自带的 wrapper 自动下载，不需要单独装。
REM  （本机默认路径只是兜底，设了上面的环境变量就优先生效）
REM ============================================================

cd /d "%~dp0"

REM ── 1. JDK ──────────────────────────────────────────────────
if not defined JAVA_HOME set "JAVA_HOME=D:\AndroidDev\jdk\jdk-17.0.20.1+1"
if not exist "%JAVA_HOME%\bin\javac.exe" (
  echo [X] 找不到 JDK: "%JAVA_HOME%"
  echo     请装 JDK 17 并设好环境变量 JAVA_HOME 再跑本脚本。
  pause
  exit /b 1
)

REM ── 2. Android SDK ──────────────────────────────────────────
if not defined ANDROID_HOME set "ANDROID_HOME=D:\AndroidDev\sdk"
if not exist "%ANDROID_HOME%" (
  echo [X] 找不到 Android SDK: "%ANDROID_HOME%"
  echo     请装 Android SDK 并设好环境变量 ANDROID_HOME 再跑本脚本。
  pause
  exit /b 1
)
REM local.properties 是机器本地文件、不该跟着工程走；缺了就按 ANDROID_HOME 生成
if not exist "local.properties" (
  > "local.properties" echo sdk.dir=%ANDROID_HOME:\=/%
  echo [i] 已生成 local.properties: sdk.dir=%ANDROID_HOME:\=/%
)

REM ── 3. Gradle ───────────────────────────────────────────────
REM 优先用本机已装的 Gradle（快、离线可用）；没有才回落到工程自带的 wrapper。
set "GRADLE_CMD="
if defined GRADLE_BIN set "GRADLE_CMD=%GRADLE_BIN%"
if not defined GRADLE_CMD if exist "D:\AndroidDev\gradle\gradle-8.11.1\bin\gradle.bat" set "GRADLE_CMD=D:\AndroidDev\gradle\gradle-8.11.1\bin\gradle.bat"
if not defined GRADLE_CMD if exist "gradlew.bat" set "GRADLE_CMD=gradlew.bat"
if not defined GRADLE_CMD (
  echo [X] 找不到 Gradle：本机没装、工程也没有 gradlew.bat。
  echo     请装 Gradle，或用 Android Studio 直接打开本工程。
  pause
  exit /b 1
)

echo [1/3] 同步网页资源到 APK
if not exist "app\src\main\assets\www\assets\js" mkdir "app\src\main\assets\www\assets\js"
if not exist "app\src\main\assets\www\assets\css" mkdir "app\src\main\assets\www\assets\css"
copy /y "..\index.html"                         "app\src\main\assets\www\" >nul
copy /y "..\assets\css\app.css"                 "app\src\main\assets\www\assets\css\" >nul
copy /y "..\assets\js\app.js"                   "app\src\main\assets\www\assets\js\" >nul
copy /y "..\assets\js\chart.js"                 "app\src\main\assets\www\assets\js\" >nul
copy /y "..\assets\js\transport.js"             "app\src\main\assets\www\assets\js\" >nul
copy /y "..\assets\js\ryken-protocol.js"        "app\src\main\assets\www\assets\js\" >nul

echo [2/3] 编译
call "%GRADLE_CMD%" assembleDebug
if errorlevel 1 (
  echo.
  echo 编译失败。
  pause
  exit /b 1
)

echo [3/3] 完成
echo.
echo   APK 目录: %CD%\app\build\outputs\apk\debug\
dir /b "app\build\outputs\apk\debug\*.APK"
echo.
echo 装到手机：把 APK 传到手机点安装即可。
echo 装到 MuMu：MuMuManager.exe control -v 0 app install --apk "<APK 绝对路径>"
echo.
pause
