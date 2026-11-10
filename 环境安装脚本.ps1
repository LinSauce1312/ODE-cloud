# ============================================================================
#  ODE-cloud 环境安装与完整性校验脚本
#  用途：第三方用户一条命令完成 Node.js 环境准备 + 项目自检
#
#  用法（在本目录下打开 PowerShell）：
#    powershell -ExecutionPolicy Bypass -File ".\环境安装脚本.ps1"
#  可选参数：
#    -SkipInstall  仅检测 Node.js，不自动安装
#    -SkipTests    跳过离线回归测试，只做完整性校验
# ============================================================================

[CmdletBinding()]
param(
    [switch]$SkipInstall,
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try { $OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $ScriptDir

function Write-Step { param([string]$Text) Write-Host ""; Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Text) Write-Host "    [通过] $Text" -ForegroundColor Green }
function Write-Info { param([string]$Text) Write-Host "    [信息] $Text" -ForegroundColor DarkGray }
function Write-Fail { param([string]$Text) Write-Host "    [失败] $Text" -ForegroundColor Red }

function Refresh-PathEnv {
    $parts = @()
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($machine) { $parts += $machine }
    if ($user)    { $parts += $user }
    $env:Path = ($parts -join ';')
}

function Test-CommandAvailable { param([string]$Name) return [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

function Get-NodeMajor {
    try {
        $out = (& node --version 2>$null | Select-Object -First 1)
        if ($out -match '^v?(\d+)') { return [int]$Matches[1] }
    } catch { }
    return 0
}

function Install-NodeWinget {
    if (-not (Test-CommandAvailable 'winget')) { return $false }
    Write-Info "使用 winget 安装 Node.js LTS（请稍候）..."
    & winget install --id OpenJS.NodeJS.LTS -e --source winget `
        --accept-source-agreements --accept-package-agreements --silent --disable-interactivity
    if ($LASTEXITCODE -ne 0) { Write-Fail "winget 安装失败（退出码 $LASTEXITCODE）"; return $false }
    Refresh-PathEnv
    return $true
}

function Install-NodeMsi {
    Write-Info "改用官方 MSI 静默安装（请稍候）..."
    try {
        $versions = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 30
        $lts = $versions | Where-Object { $_.lts } | Select-Object -First 1
        if (-not $lts) { Write-Fail "无法从 nodejs.org 获取 LTS 版本列表"; return $false }
        $ver  = $lts.version
        $arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
        $msiUrl  = "https://nodejs.org/dist/$ver/node-$ver-$arch.msi"
        $msiPath = Join-Path $env:TEMP "node-$ver-$arch.msi"
        Write-Info "下载 $msiUrl"
        Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath -TimeoutSec 600
        Write-Info "静默安装 $msiPath"
        $proc = Start-Process msiexec.exe -ArgumentList "/i `"$msiPath`" /qn /norestart" -Wait -PassThru
        if ($proc.ExitCode -ne 0) { Write-Fail "MSI 安装失败（退出码 $($proc.ExitCode)）"; return $false }
        Remove-Item $msiPath -Force -ErrorAction SilentlyContinue
        Refresh-PathEnv
        return $true
    } catch {
        Write-Fail "MSI 安装异常：$($_.Exception.Message)"
        return $false
    }
}

function Ensure-Node {
    $major = Get-NodeMajor
    if ($major -ge 22) {
        $full = (& node --version 2>$null | Select-Object -First 1).Trim()
        Write-Ok "检测到 Node.js $full（满足 >= 22 要求）"
        return $true
    }
    if ($major -gt 0) {
        Write-Info "检测到 Node.js $((& node --version 2>$null).Trim())，但低于 22，需要升级"
    } else {
        Write-Info "未检测到 Node.js"
    }
    if ($SkipInstall) {
        Write-Fail "缺少 Node.js 22+，且已指定 -SkipInstall，无法继续"
        return $false
    }
    Write-Step "开始安装 Node.js 22+"
    $ok = Install-NodeWinget
    if (-not $ok) { $ok = Install-NodeMsi }
    if (-not $ok) {
        Write-Fail "自动安装失败。请手动安装 Node.js 22+：https://nodejs.org/"
        Write-Info "安装完成后重新打开终端，再运行本脚本"
        return $false
    }
    Refresh-PathEnv
    $major = Get-NodeMajor
    if ($major -lt 22) {
        $full = if (Test-CommandAvailable 'node') { (& node --version 2>$null).Trim() } else { '(不可用)' }
        Write-Fail "安装后仍无法使用 Node.js 22+（当前：$full）"
        Write-Info "请关闭并重新打开终端后重试（PATH 需要刷新）"
        return $false
    }
    Write-Ok "Node.js $((& node --version 2>$null).Trim()) 安装并验证通过"
    return $true
}

# ---- 主流程 ----
Write-Host ""
Write-Host "============================================================" -ForegroundColor Magenta
Write-Host "  ODE-cloud 环境安装与完整性校验" -ForegroundColor Magenta
Write-Host "============================================================" -ForegroundColor Magenta

Write-Step "1/4 检测 Node.js 环境（要求 22+）"
if (-not (Ensure-Node)) { Write-Fail "环境准备失败，终止"; exit 1 }

Write-Step "2/4 项目完整性校验（node scripts/check.mjs）"
& node scripts/check.mjs
if ($LASTEXITCODE -ne 0) { Write-Fail "完整性校验未通过（退出码 $LASTEXITCODE）"; exit 1 }
Write-Ok "完整性校验通过（文件白名单、语法、导入边界均正常）"

Write-Step "3/4 CLI 入口冒烟（node cli.mjs --help）"
& node cli.mjs --help > $null
if ($LASTEXITCODE -ne 0) { Write-Fail "CLI 入口冒烟未通过（退出码 $LASTEXITCODE）"; exit 1 }
Write-Ok "CLI 入口可正常启动"

if (-not $SkipTests) {
    Write-Step "4/4 离线回归测试（node --test）"
    & node --test "test/*.test.mjs"
    if ($LASTEXITCODE -ne 0) { Write-Fail "回归测试未通过（退出码 $LASTEXITCODE）"; exit 1 }
    Write-Ok "离线回归测试全部通过"
} else {
    Write-Step "4/4 已跳过回归测试（-SkipTests）"
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  环境就绪，可直接使用：" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host '  查看命令帮助：      node cli.mjs --help'
Write-Host '  登录网盘：          node cli.mjs login quark'
Write-Host '  在线校验账号：      node cli.mjs status quark --verify'
Write-Host '  列出分享文件：      node cli.mjs share "官方分享链接"'
Write-Host '  下载分享文件：      node cli.mjs get "官方分享链接" --output "D:/Downloads"'
Write-Host '  普通直链下载：      node cli.mjs direct "https://example.com/file.zip" --output "downloads/file.zip"'
Write-Host ""
Write-Host "  完整教程见 USAGE.md，开发说明见 DEVELOPMENT.md"
exit 0
