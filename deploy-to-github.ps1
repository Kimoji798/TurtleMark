# TurtleMark 一键部署脚本（双击 deploy-to-github.bat 运行）
[CmdletBinding()]
param([switch]$DryRun)

Set-Location -LiteralPath $PSScriptRoot
$ErrorActionPreference = 'Stop'
cmd /c chcp 65001 > $null
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$configFile = Join-Path $PSScriptRoot 'deploy-config.txt'
$stringsXml = Join-Path $PSScriptRoot 'android\app\src\main\res\values\strings.xml'

function Write-Step([string]$msg) { Write-Host ('  ' + $msg) }
function Write-Err([string]$msg) { Write-Host ('  [错误] ' + $msg) -ForegroundColor Red }
function Write-OK([string]$msg) { Write-Host ('  [完成] ' + $msg) -ForegroundColor Green }

Write-Host ''
Write-Host '  =========================================='
Write-Host '    TurtleMark 一键部署到 GitHub'
Write-Host '  =========================================='
Write-Host ''

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Err '未检测到 git，请先安装：https://git-scm.com/download/win'
    exit 1
}

# 读取或输入仓库地址（用户名只需输入一次，会保存到 deploy-config.txt）
$repo = $null
if (Test-Path $configFile) {
    $repo = (Get-Content -LiteralPath $configFile -Raw).Trim()
    if ($repo -notmatch 'github\.com') { $repo = $null }
}
if (-not $repo) {
    Write-Host '  首次运行：请输入你的 GitHub 用户名（只需输入一次），例如：'
    Write-Host '    https://github.com/你的用户名/TurtleMark.git'
    Write-Host ''
    $userInput = (Read-Host '  GitHub 用户名（或完整仓库地址）').Trim()
    if (-not $userInput) { Write-Err '仓库地址不能为空'; exit 1 }
    if ($userInput -match '^https?://|^git@') {
        $repo = $userInput
    } else {
        $user = $userInput -replace '[/\\\s]', ''
        if ($user -notmatch '^[A-Za-z0-9-]+$') { Write-Err '用户名格式不正确（只能包含字母、数字、-）'; exit 1 }
        $repo = "https://github.com/$user/TurtleMark.git"
    }
    Set-Content -LiteralPath $configFile -Value $repo -Encoding ASCII
}

$m = [regex]::Match($repo, '(?:github\.com[:/])([A-Za-z0-9_-]+)')
if (-not $m.Success) {
    Write-Err '仓库地址格式不正确，请删除 deploy-config.txt 后重新双击本脚本'
    exit 1
}
$ghUser = $m.Groups[1].Value

Write-Host ('  目标仓库: ' + $repo)
Write-Host ''

# 初始化本地 Git 仓库
if (-not (Test-Path '.git')) {
    Write-Step '初始化本地 Git 仓库...'
    git init | Out-Null
    git branch -M main
}

# 设置远程地址
cmd /c "git remote get-url origin >nul 2>nul"
if ($LASTEXITCODE -ne 0) {
    git remote add origin $repo
} else {
    git remote set-url origin $repo
}

# 首次提交需要 Git 身份信息
cmd /c "git config user.name >nul 2>nul"
if ($LASTEXITCODE -ne 0) {
    Write-Host '  首次提交需要你的 Git 身份信息：'
    $gitName = Read-Host '  你的名字/昵称'
    $gitEmail = Read-Host '  你的邮箱'
    if ($gitName) { git config user.name $gitName }
    if ($gitEmail) { git config user.email $gitEmail }
}

# 把安卓壳的网页地址更新为你的 GitHub Pages 地址
if (Test-Path $stringsXml) {
    Write-Step '正在把安卓壳的网页地址更新为你的 GitHub Pages 地址...'
    $t = [IO.File]::ReadAllText($stringsXml, [Text.Encoding]::UTF8)
    $t = [regex]::Replace($t, 'https://[A-Za-z0-9_-]+\.github\.io/TurtleMark/', "https://$ghUser.github.io/TurtleMark/")
    [IO.File]::WriteAllText($stringsXml, $t, (New-Object Text.UTF8Encoding($false)))
}

if (-not $DryRun) {
    Write-Step '正在添加文件并提交...'
    git add -A
    git commit -m "Update TurtleMark" 2>$null
    if ($LASTEXITCODE -ne 0) { Write-Host '      （没有需要提交的更改，直接推送）' }

    # 先检查远程仓库是否可达，给出明确提示
    Write-Step '正在检查远程仓库...'
    cmd /c "git ls-remote origin HEAD >nul 2>nul"
    if ($LASTEXITCODE -ne 0) {
        Write-Err '无法访问远程仓库，请确认：'
        Write-Err ('  1. 仓库存在：' + $repo)
        Write-Err '  2. 已登录 GitHub（首次推送会弹出浏览器登录窗口）'
        Write-Err '  3. 你有该仓库的写权限；如需更换地址，删除 deploy-config.txt 后重试'
        exit 1
    }

    Write-Step '正在推送到 GitHub（首次会弹出浏览器登录窗口）...'
    git push -u origin main
    if ($LASTEXITCODE -ne 0) {
        Write-Host ''
        Write-Host '  推送被拒绝，尝试与远程已有内容合并（远程如有 README 等文件）...'
        cmd /c "git ls-remote --heads origin main >nul 2>nul"
        if ($LASTEXITCODE -eq 0) {
            git pull -X ours origin main --allow-unrelated-histories
            if ($LASTEXITCODE -eq 0) { git push -u origin main }
        } else {
            git push -u origin main
        }
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Host ''
        Write-Err '推送失败。常见原因：网络问题 / 未登录 GitHub / 仓库地址或仓库名不一致。'
        Write-Err '如需更换仓库地址，删除 deploy-config.txt 后重新双击本脚本。'
        exit 1
    }
} else {
    Write-OK '本地检查通过（测试模式，未提交、未推送）'
    exit 0
}

Write-Host ''
Write-Host '  =========================================='
Write-OK '部署成功！'
Write-Host '  =========================================='
Write-Host ''
Write-Host '  只需配置一次（之后双击本脚本即可一键更新）：'
Write-Host '    1. 打开 GitHub 仓库页面 → Settings → Pages'
Write-Host '    2. Build and deployment 的 Source 选择 "GitHub Actions"'
Write-Host '    3. 保存后约 1-2 分钟，网页自动上线：'
Write-Host ('       https://' + $ghUser + '.github.io/TurtleMark/')
Write-Host ''
Write-Host '  安卓 APK（云端自动构建，无需本机装 Java）：'
Write-Host '    仓库页面 → Actions → 左侧 "构建 Android APK" → Run workflow'
Write-Host '    完成后在构建详情页底部 Artifacts 下载 TurtleMark-APK'
Write-Host ''
Write-Host '  iPhone 使用：'
Write-Host '    用 Safari 打开上面的网址 → 分享按钮 → 添加到主屏幕'
Write-Host ''
