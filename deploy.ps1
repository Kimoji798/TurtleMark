param(
  [string]$RepoName = "",
  [switch]$Dry
)

Set-Location $PSScriptRoot

$log = Join-Path $PSScriptRoot "deploy-log.txt"
Start-Transcript -Path $log -Force | Out-Null

if ([string]::IsNullOrWhiteSpace($RepoName)) {
  $RepoName = Read-Host "输入 GitHub 仓库名 [TurtleMark]"
}
if ([string]::IsNullOrWhiteSpace($RepoName)) { $RepoName = "TurtleMark" }

$pushArgs = @("-c", "http.proxy=http://127.0.0.1:7897", "-c", "https.proxy=http://127.0.0.1:7897")

if (-not (Test-Path ".git")) { git init -b main | Out-Null }

if (-not (git config user.name)) { git config user.name "Kimoji798" }
if (-not (git config user.email)) { git config user.email "kimoji798@users.noreply.github.com" }

# 更新安卓壳里的网页地址
$stringsXml = Join-Path $PSScriptRoot "android\app\src\main\res\values\strings.xml"
if (Test-Path $stringsXml) {
  $t = [IO.File]::ReadAllText($stringsXml, [Text.Encoding]::UTF8)
  $t = [regex]::Replace($t, 'https://[A-Za-z0-9_-]+\.github\.io/TurtleMark/', "https://kimoji798.github.io/$RepoName/")
  [IO.File]::WriteAllText($stringsXml, $t, (New-Object Text.UTF8Encoding($false)))
}

Write-Host ""
Write-Host ("[1/4] 本地提交，仓库名 = " + $RepoName)
git add .
git commit -m ("部署 TurtleMark: " + (Get-Date -Format 'yyyy-MM-dd HH:mm'))
if ($LASTEXITCODE -ne 0) { Write-Host "(没有新改动，跳过提交)" }

git remote remove origin 2>$null
git remote add origin "https://github.com/Kimoji798/$RepoName.git"

if ($Dry) {
  Write-Host ""
  Write-Host "[DRY] 跳过推送"
  Write-Host "[DRY] 远程仓库: https://github.com/Kimoji798/$RepoName.git"
  Write-Host "[DRY] 网站地址: https://kimoji798.github.io/$RepoName/"
  Stop-Transcript | Out-Null
  exit 0
}

Write-Host ""
Write-Host "[2/4] 推送完整版到 dev 分支..."
git @pushArgs push -u origin main:dev
if ($LASTEXITCODE -ne 0) {
  Write-Host "[错误] dev 推送失败，请看上面 git 的报错信息"
  Write-Host "常见原因: 代理没开 / 仓库不存在 / 登录过期"
  Read-Host "按回车关闭"
  Stop-Transcript | Out-Null
  exit 1
}

Write-Host ""
Write-Host "[3/4] 推送 main 分支（触发网页和安卓 APK 自动构建）..."
git @pushArgs push -u origin main:main
if ($LASTEXITCODE -ne 0) {
  Write-Host "[错误] main 推送失败，请看上面 git 的报错信息"
  Read-Host "按回车关闭"
  Stop-Transcript | Out-Null
  exit 1
}

Write-Host ""
Write-Host "[4/4] 验证远程 main 分支..."
$localHead = (git rev-parse HEAD).Trim()
Write-Host ("本地 HEAD = " + $localHead)
$remoteMain = git @pushArgs ls-remote origin refs/heads/main
if ($LASTEXITCODE -eq 0) {
  Write-Host ("远程 main = " + $remoteMain.Trim())
  if ($remoteMain -match $localHead) {
    Write-Host "远程 main 已是最新，GitHub 应已开始部署"
  } else {
    Write-Host "[警告] 远程 main 和本地不一致"
  }
} else {
  Write-Host "[警告] 无法读取远程分支（代理或网络问题）"
}

Write-Host ""
Write-Host "=============================================="
Write-Host ("  网页地址: https://kimoji798.github.io/$RepoName/")
Write-Host ("  安卓 APK: https://github.com/Kimoji798/$RepoName/actions/workflows/build-apk.yml")
Write-Host ("  部署记录: https://github.com/Kimoji798/$RepoName/actions")
Write-Host "  首次部署：到仓库 Settings -> Pages -> Source 选 GitHub Actions 并 Save（只需一次）"
Write-Host "  若 Actions 报 Resource not accessible by integration："
Write-Host "    说明 Pages 还没启用 -> 打开 https://github.com/Kimoji798/$RepoName/settings/pages 选 GitHub Actions -> Save"
Write-Host "    然后回 Actions 页对失败的运行点 Re-run all jobs（或再双击本脚本推送一次）"
Write-Host "  如果仓库是 Private，Pages 需要付费套餐，可改为 Public"
Write-Host "  若 Actions 报 Branch not allowed / environment protection rules："
Write-Host "    打开 https://github.com/Kimoji798/$RepoName/settings/environments -> github-pages -> Deployment branches 选 All branches -> Save"
Write-Host "    然后回 Actions 页对失败的运行点 Re-run all jobs"
Write-Host "  如果 5 分钟后 Actions 没有新记录，把本窗口文字截图给 AI"
Write-Host "=============================================="
Read-Host "按回车关闭"
Stop-Transcript | Out-Null
