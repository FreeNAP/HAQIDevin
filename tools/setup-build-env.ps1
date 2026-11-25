# 本地 APK 构建环境一键配置 — 下载完成后运行一次即可
# 用法: powershell -ExecutionPolicy Bypass -File tools\setup-build-env.ps1
$ErrorActionPreference = 'Stop'
$tools = "$env:USERPROFILE\dev-tools"
Write-Host "== HAQIDevin 本地构建环境配置 =="

# 0. 确保下载完成 (断点续传, 走系统代理加速 google)
New-Item -ItemType Directory -Path $tools -Force | Out-Null
$jdkZip = "$tools\jdk17.zip"
$sdkZip = "$tools\sdk-tools.zip"
if (-not (Test-Path "$tools\jdk-17") -and ((not (Test-Path $jdkZip)) -or (Get-Item $jdkZip).Length -lt 150MB)) {
  Write-Host "续传 JDK 17..."
  curl.exe -sL -o $jdkZip -C - "https://aka.ms/download-jdk/microsoft-jdk-17.0.13-windows-x64.zip"
}
if (-not (Test-Path "$toolsndroid-sdk\cmdline-tools\latest") -and ((not (Test-Path $sdkZip)) -or (Get-Item $sdkZip).Length -lt 100MB)) {
  Write-Host "续传 Android SDK tools (代理)..."
  curl.exe -sL -x "http://127.0.0.1:10808" -o $sdkZip -C - "https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip"
}

# 1. JDK 17 解压
if (-not (Test-Path "$tools\jdk-17")) {
  if (-not (Test-Path "$tools\jdk17.zip")) { throw "jdk17.zip 未下载完成, 稍后重试" }
  Write-Host "解压 JDK 17..."
  Expand-Archive -Path "$tools\jdk17.zip" -DestinationPath "$tools\jdk-tmp" -Force
  $jdkDir = Get-ChildItem "$tools\jdk-tmp" -Directory | Select-Object -First 1
  Move-Item $jdkDir.FullName "$tools\jdk-17"
  Remove-Item "$tools\jdk-tmp" -Recurse -Force
}
Write-Host "JDK: $tools\jdk-17"

# 2. Android SDK 解压 + 必要组件
if (-not (Test-Path "$tools\android-sdk\cmdline-tools\latest")) {
  if (-not (Test-Path "$tools\sdk-tools.zip")) { throw "sdk-tools.zip 未下载完成, 稍后重试" }
  Write-Host "解压 Android SDK cmdline-tools..."
  Expand-Archive -Path "$tools\sdk-tools.zip" -DestinationPath "$tools\sdk-tmp" -Force
  New-Item -ItemType Directory -Path "$tools\android-sdk\cmdline-tools\latest" -Force | Out-Null
  Copy-Item "$tools\sdk-tmp\cmdline-tools\*" "$tools\android-sdk\cmdline-tools\latest" -Recurse -Force
  Remove-Item "$tools\sdk-tmp" -Recurse -Force
}
$sdkmanager = "$tools\android-sdk\cmdline-tools\latest\bin\sdkmanager.bat"
$env:JAVA_HOME = "$tools\jdk-17"
Write-Host "安装 SDK 组件 (licenses + platform-34 + build-tools)..."
echo y | & $sdkmanager --licenses 2>&1 | Select-Object -Last 1
& $sdkmanager "platforms;android-34" "build-tools;34.0.0" "platform-tools" 2>&1 | Select-Object -Last 2
Write-Host "== 完成! 构建用 tools\build-apk-local.bat =="
