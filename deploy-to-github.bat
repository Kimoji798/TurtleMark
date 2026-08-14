@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title TurtleMark 一键部署到 GitHub

echo.
echo  ==========================================
echo    TurtleMark 一键部署到 GitHub
echo  ==========================================
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo  [错误] 未检测到 git，请先安装：https://git-scm.com/download/win
  echo.
  pause
  exit /b 1
)

set "REPO="
if exist deploy-config.txt (
  set /p REPO=<deploy-config.txt
)

if not defined REPO (
  echo  首次运行：请输入你的 GitHub 仓库地址（只需输入一次），例如：
  echo    https://github.com/你的用户名/TurtleMark.git
  echo.
  set /p REPO=仓库地址: 
  echo !REPO!>deploy-config.txt
)

if not defined REPO (
  echo  [错误] 仓库地址不能为空
  pause
  exit /b 1
)

rem 从仓库地址提取 GitHub 用户名（兼容 https 与 SSH 两种写法）
set "GHUSER=!REPO!"
set "GHUSER=!GHUSER:https://=!"
set "GHUSER=!GHUSER:http://=!"
set "GHUSER=!GHUSER:git@github.com:=!"
set "GHUSER=!GHUSER:github.com/=!"
for /f "delims=/" %%u in ("!GHUSER!") do set "GHUSER=%%u"

echo  目标仓库: !REPO!
echo.

if not exist .git (
  echo  初始化本地 Git 仓库...
  git init
  git branch -M main
)

git remote get-url origin >nul 2>nul
if errorlevel 1 (
  git remote add origin "!REPO!"
) else (
  git remote set-url origin "!REPO!"
)

git config user.name >nul 2>nul
if errorlevel 1 (
  echo  首次提交需要你的 Git 身份信息：
  set /p GIT_NAME=你的名字/昵称: 
  set /p GIT_EMAIL=你的邮箱: 
  git config user.name "!GIT_NAME!"
  git config user.email "!GIT_EMAIL!"
  echo.
)

if defined GHUSER (
  echo  正在把安卓壳的网页地址更新为你的 GitHub Pages 地址...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=Join-Path (Get-Location) 'android\app\src\main\res\values\strings.xml'; $t=[IO.File]::ReadAllText($p); $t=[Text.RegularExpressions.Regex]::Replace($t,'https://[A-Za-z0-9_-]+\.github\.io/TurtleMark/','https://!GHUSER!.github.io/TurtleMark/'); [IO.File]::WriteAllText($p,$t,(New-Object Text.UTF8Encoding($false)))"
  echo.
)

echo  正在添加文件并提交...
git add -A
git commit -m "Update TurtleMark" >nul 2>nul
if errorlevel 1 echo     （没有需要提交的更改，直接推送）

echo  正在推送到 GitHub（首次会弹出浏览器登录窗口）...
git push -u origin main

if errorlevel 1 (
  echo.
  echo  推送被拒绝，尝试与远程已有内容合并（远程如有 README 等文件）...
  git pull -X ours origin main --allow-unrelated-histories
  if not errorlevel 1 (
    git push -u origin main
  )
)

if errorlevel 1 (
  echo.
  echo  ==========================================
  echo    ❌ 部署失败
  echo  ==========================================
  echo  常见原因：
  echo    1. 网络问题 / 未登录 GitHub —— 双击本脚本重试即可
  echo    2. 仓库地址错误 —— 删除 deploy-config.txt 后重试
  echo    3. 仓库有提交保护 —— 在 GitHub 网页上检查仓库设置
  echo.
  pause
  exit /b 1
)

echo.
echo  ==========================================
echo    ✅ 部署成功！
echo  ==========================================
echo.
echo  ⚠ 只需配置一次（之后双击本脚本即可一键更新）：
echo    1. 打开 GitHub 仓库页面 → Settings → Pages
echo    2. Build and deployment 的 Source 选择 "GitHub Actions"
echo    3. 保存后约 1-2 分钟，网页自动上线：
if defined GHUSER (
  echo       https://!GHUSER!.github.io/TurtleMark/
) else (
  echo       https://你的用户名.github.io/TurtleMark/
)
echo.
echo  📱 安卓 APK（云端自动构建，无需本机装 Java）：
echo    仓库页面 → Actions → 左侧 "构建 Android APK" → Run workflow
echo    完成后在构建详情页底部 Artifacts 下载 TurtleMark-APK
echo.
echo  🍎 iPhone 使用：
echo    用 Safari 打开上面的网址 → 分享按钮 → 添加到主屏幕
echo.
pause