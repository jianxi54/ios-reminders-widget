# ============================================================
#  构建 Windows 安装包
#  产物: dist\RemindersWidget-Setup-v<版本>.exe（单文件，内置 Node 运行时）
#
#  用法: powershell -ExecutionPolicy Bypass -File packaging\build.ps1
# ============================================================
param(
    [switch]$SkipIcon
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path $PSScriptRoot -Parent
$work = Join-Path $PSScriptRoot '_work'
$payload = Join-Path $work 'payload'
$zip = Join-Path $PSScriptRoot 'setup\payload.zip'
$setupDir = Join-Path $PSScriptRoot 'setup'
$uninstDir = Join-Path $PSScriptRoot 'uninstall'
$dist = Join-Path $root 'dist'

function Step($msg) { Write-Host ("  " + $msg) -ForegroundColor Gray }
function Ok($msg) { Write-Host ("  [OK] " + $msg) -ForegroundColor Green }

# ---------- 版本 ----------
$vj = Get-Content (Join-Path $root 'lib\version.js') -Raw
if ($vj -match "VERSION\s*=\s*'([\d\.]+)'") { $ver = $Matches[1] } else { throw '无法从 lib/version.js 读取版本号' }
Write-Host "`n构建 提醒事项小组件 V$ver" -ForegroundColor Cyan

# ---------- 清理 ----------
if (Test-Path $work) { [System.IO.Directory]::Delete($work, $true) }
New-Item -ItemType Directory -Force -Path $payload | Out-Null
New-Item -ItemType Directory -Force -Path $dist | Out-Null

# ---------- Node 运行时 ----------
$nodeSrc = Join-Path $PSScriptRoot 'runtime\node.exe'
if (-not (Test-Path $nodeSrc)) {
    $cands = @()
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $cands += $cmd.Source }
    $cands += @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe")
    foreach ($c in $cands) { if ($c -and (Test-Path $c)) { $nodeSrc = $c; break } }
}
if (-not (Test-Path $nodeSrc)) { throw '未找到 node.exe，请安装 Node.js 或把 node.exe 放到 packaging\runtime\node.exe' }
Step ("Node 运行时: " + $nodeSrc + "  (" + [Math]::Round((Get-Item $nodeSrc).Length / 1MB, 1) + " MB)")

# ---------- 图标 ----------
$ico = Join-Path $setupDir 'app.ico'
if (-not $SkipIcon -and -not (Test-Path $ico)) {
    Step '生成图标…'
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'make-icon.ps1') | Out-Null
}
if (-not (Test-Path $ico)) { throw '缺少 packaging\setup\app.ico' }

# ---------- 版本信息 ----------
$buildInfo = Join-Path $setupDir 'BuildInfo.cs'
$content = "namespace RemindersSetup`r`n{`r`n    internal static class BuildInfo`r`n    {`r`n        public const string Version = `"V$ver`";`r`n    }`r`n}`r`n"
[System.IO.File]::WriteAllText($buildInfo, $content, (New-Object System.Text.UTF8Encoding($false)))

# csproj 里的文件版本同步（显式按 UTF-8 读写，避免 PowerShell 5.1 按 ANSI 解码破坏中文）
$fv = "$ver.0.0"
foreach ($csproj in @((Join-Path $setupDir 'Setup.csproj'), (Join-Path $uninstDir 'Uninstall.csproj'))) {
    $cs = [System.IO.File]::ReadAllText($csproj, [System.Text.Encoding]::UTF8)
    $cs = [regex]::Replace($cs, '<FileVersion>[^<]*</FileVersion>', "<FileVersion>$fv</FileVersion>")
    $cs = [regex]::Replace($cs, '<AssemblyVersion>[^<]*</AssemblyVersion>', "<AssemblyVersion>$fv</AssemblyVersion>")
    $cs = [regex]::Replace($cs, '<Version>[^<]*</Version>', "<Version>$ver</Version>")
    [System.IO.File]::WriteAllText($csproj, $cs, (New-Object System.Text.UTF8Encoding($true)))
}

# ---------- 关闭正在运行的实例（否则宿主 exe 被占用） ----------
Step '关闭正在运行的实例…'
Get-Process RemindersWidget -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
$listener = Get-NetTCPConnection -LocalPort 8642 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) { Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 900

# ---------- 编译宿主 ----------
Step '编译宿主…'
$hb = & dotnet build (Join-Path $root 'host\WidgetHost.csproj') -c Release --nologo --no-incremental -p:DebugType=None -p:DebugSymbols=false 2>&1
if ($LASTEXITCODE -ne 0) {
    $hb | ForEach-Object { Write-Host $_ -ForegroundColor DarkGray }
    throw '宿主编译失败'
}
$hostExe = Join-Path $root 'host\bin\Release\RemindersWidget.exe'
if (-not (Test-Path $hostExe)) { throw '未找到宿主编译产物' }
Copy-Item $hostExe (Join-Path $root 'host\RemindersWidget.exe') -Force
Ok 'RemindersWidget.exe 已更新'

# ---------- 组装载荷 ----------
function Add-File([string]$rel) {
    $s = Join-Path $root $rel
    if (-not (Test-Path $s)) { throw "缺少文件: $rel" }
    $d = Join-Path $payload $rel
    $parent = Split-Path $d -Parent
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Copy-Item $s $d -Force
}

$list = @(
    'server.js',
    'LICENSE',
    'THIRD-PARTY-NOTICES.txt',
    'README.md',
    'start-widget.bat',
    'login-icloud.bat',
    'public\index.html',
    'public\app.js',
    'public\style.css',
    'tools\browser-login.js',
    'host\RemindersWidget.exe',
    'host\Microsoft.Web.WebView2.Core.dll',
    'host\Microsoft.Web.WebView2.WinForms.dll',
    'host\WebView2Loader.dll'
)
Get-ChildItem (Join-Path $root 'lib') -File -Filter *.js | ForEach-Object { $list += ('lib\' + $_.Name) }

foreach ($rel in $list) { Add-File $rel }

New-Item -ItemType Directory -Force -Path (Join-Path $payload 'node') | Out-Null
Copy-Item $nodeSrc (Join-Path $payload 'node\node.exe') -Force

# ---------- 独立卸载器 ----------
Step '编译卸载器…'
$uninstBin = Join-Path $work 'uninst-bin'
$b1 = & dotnet build (Join-Path $uninstDir 'Uninstall.csproj') -c Release -o $uninstBin --nologo 2>&1
if ($LASTEXITCODE -ne 0) {
    $b1 | ForEach-Object { Write-Host $_ -ForegroundColor DarkGray }
    throw '卸载器编译失败'
}
$uninstExe = Join-Path $uninstBin 'Uninstall.exe'
if (-not (Test-Path $uninstExe)) { throw '未找到 Uninstall.exe' }
Copy-Item $uninstExe (Join-Path $payload 'Uninstall.exe') -Force
Ok ("Uninstall.exe " + [Math]::Round((Get-Item $uninstExe).Length / 1KB, 1) + " KB")

Step ("载荷文件数: " + (Get-ChildItem $payload -Recurse -File).Count)

# ---------- 隐私自检 ----------
Step '隐私自检…'

# 通用规则：任何 Windows 用户目录路径、settings.json 里的长 Key、会话字段
$patterns = @(
    'C:\\\\Users\\\\[^\\\\"\s]+',
    'C:/Users/[^/"\s]+',
    '"key"\s*:\s*"[A-Za-z0-9]{15,}"',
    'X-APPLE-WEBAUTH-TOKEN"\s*:'
)

# 本机专属值放在不入库的文件里（.gitignore 已排除），避免把真实密钥写进仓库
$localPatterns = Join-Path $PSScriptRoot 'privacy.local.txt'
if (Test-Path $localPatterns) {
    foreach ($line in [System.IO.File]::ReadAllLines($localPatterns, [System.Text.Encoding]::UTF8)) {
        $t = $line.Trim()
        if ($t -and -not $t.StartsWith('#')) { $patterns += $t }
    }
    Step ("已载入本地规则 " + (($patterns.Count - 4)) + " 条")
}
else {
    Step '未找到 privacy.local.txt，仅使用通用规则'
}

$hits = @()
Get-ChildItem $payload -Recurse -File |
    Where-Object { $_.Extension -in @('.js', '.html', '.css', '.bat', '.md', '.json', '.txt') } |
    ForEach-Object {
        $txt = [System.IO.File]::ReadAllText($_.FullName, [System.Text.Encoding]::UTF8)
        foreach ($p in $patterns) {
            if ($txt -match $p) { $hits += ($_.FullName.Replace($payload, '') + '  ← ' + $p) }
        }
    }
if ($hits.Count -gt 0) {
    Write-Host "`n发现疑似私密/本机信息，已中止打包：" -ForegroundColor Red
    $hits | ForEach-Object { Write-Host ("    " + $_) -ForegroundColor Red }
    throw '打包中止：请先清理上述内容'
}

# 二进制也要查：曾把带本机路径的调试信息打进宿主 exe
$binPatterns = @('Users\\\\[A-Za-z0-9_.-]{2,}')
if (Test-Path $localPatterns) {
    foreach ($line in [System.IO.File]::ReadAllLines($localPatterns, [System.Text.Encoding]::UTF8)) {
        $t = $line.Trim()
        if ($t -and -not $t.StartsWith('#')) { $binPatterns += $t }
    }
}
foreach ($bin in (Get-ChildItem $payload -Recurse -File | Where-Object { $_.Extension -in @('.exe', '.dll') })) {
    if ($bin.Name -eq 'node.exe') { continue }
    $bytes = [System.IO.File]::ReadAllBytes($bin.FullName)
    $asU16 = [System.Text.Encoding]::Unicode.GetString($bytes)
    $asU8 = [System.Text.Encoding]::UTF8.GetString($bytes)
    foreach ($p in $binPatterns) {
        if (($asU16 -match $p) -or ($asU8 -match $p)) {
            Write-Host ("`n二进制中发现本机信息：" + $bin.Name + "  ← " + $p) -ForegroundColor Red
            throw '打包中止：可执行文件里含本机路径或密钥'
        }
    }
}
Ok '未发现私密数据、密钥或本机路径（含二进制）'

# ---------- 压缩 ----------
Step '压缩载荷…'
if (Test-Path $zip) { [System.IO.File]::Delete($zip) }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
    $payload, $zip,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false)
Ok ("payload.zip " + [Math]::Round((Get-Item $zip).Length / 1MB, 1) + " MB")

# ---------- 编译安装器 ----------
Step '编译安装器…'
$outBin = Join-Path $work 'bin'
$build = & dotnet build (Join-Path $setupDir 'Setup.csproj') -c Release -o $outBin --nologo 2>&1
if ($LASTEXITCODE -ne 0) {
    $build | ForEach-Object { Write-Host $_ -ForegroundColor DarkGray }
    throw '安装器编译失败'
}

$exeSrc = Join-Path $outBin 'RemindersWidget-Setup.exe'
if (-not (Test-Path $exeSrc)) { throw '未找到编译产物 RemindersWidget-Setup.exe' }

$exeDst = Join-Path $dist ("RemindersWidget-Setup-v$ver.exe")
Copy-Item $exeSrc $exeDst -Force
Ok ("安装包 " + [Math]::Round((Get-Item $exeDst).Length / 1MB, 1) + " MB")

# ---------- 校验与清单 ----------
$hash = (Get-FileHash $exeDst -Algorithm SHA256).Hash
$info = @(
    "提醒事项小组件 安装包",
    "版本: V$ver",
    "文件: " + (Split-Path $exeDst -Leaf),
    "大小: " + [Math]::Round((Get-Item $exeDst).Length / 1MB, 2) + " MB",
    "SHA256: $hash",
    "",
    "安装: 双击运行，按向导完成（无需管理员权限）",
    "卸载: Windows 设置 → 应用 → 提醒事项小组件 → 卸载"
) -join "`r`n"
[System.IO.File]::WriteAllText((Join-Path $dist 'SHA256.txt'), ($hash + "  " + (Split-Path $exeDst -Leaf) + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::WriteAllText((Join-Path $dist 'BUILD-INFO.txt'), ($info + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))

Write-Host ""
Write-Host ("完成 → " + $exeDst) -ForegroundColor Green
Write-Host ("SHA256 " + $hash) -ForegroundColor DarkGray
