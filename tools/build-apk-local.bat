@echo off
REM 本地一键构建+装机 — 增量 3-8 分钟, 首次 15-25 分钟 (prebuild+全量编译)
REM 前提: 先运行 powershell -ExecutionPolicy Bypass -File tools\setup-build-env.ps1
set JAVA_HOME=%USERPROFILE%\dev-tools\jdk-17
set ANDROID_HOME=%USERPROFILE%\dev-tools\android-sdk
set PATH=%JAVA_HOME%\bin;%ANDROID_HOME%\platform-tools;%PATH%
cd /d "%~dp0\..\packages\mobile"

if not exist android (
  echo == 首次: expo prebuild 生成 android 目录 ==
  call npm install --legacy-peer-deps
  call npx expo prebuild --platform android --no-install
)

echo == 构建 release APK (本地) ==
cd android
call gradlew assembleRelease --parallel -x lint 2>&1 | findstr /C:"BUILD" /C:"error" /C:"FAIL"
if errorlevel 1 (echo 构建失败 & exit /b 1)

echo == 安装到设备 ==
adb install -r app\build\outputs\apk\release\app-release.apk 2>&1 | findstr /C:"Success" /C:"error" /C:"adb"
echo == 完成 ==
