# install.ps1 — 安装 Codex Token Usage
# 用法: powershell -ExecutionPolicy Bypass -File .\install.ps1
param(
  [string]$InstallDir = (Join-Path $env:USERPROFILE ".codex\codex-token-usage"),
  [switch]$NoAutostart,
  [switch]$NoPlugin
)
$ErrorActionPreference = "Stop"
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host "[install] 源目录   $src"
Write-Host "[install] 安装目录 $InstallDir"

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host "[install] 未找到 Node.js，请先安装 Node.js 22+"; exit 1 }
Write-Host "[install] node     $node"

$items = @("index.html","serve.mjs","export.mjs","render-usage.mjs","widgetd.mjs","widget-boot.ps1","widget-boot.vbs","watchdog.ps1","watchdog-boot.vbs","watchdog-stop.vbs","restart-codex.ps1","widget-on.bat","widget-off.bat","start-dashboard.bat","restart-codex.bat","README.md","LICENSE",".agents","plugin","tools")
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
foreach ($it in $items) {
  $s = Join-Path $src $it
  if (Test-Path -LiteralPath $s) { Copy-Item -LiteralPath $s -Destination (Join-Path $InstallDir $it) -Recurse -Force }
}
Write-Host "[install] 文件已复制"
# 把 SKILL.md 里的 {{DASH_DIR}} 换成真实安装路径
$skill = Join-Path $InstallDir "plugin\skills\token-usage\SKILL.md"
if (Test-Path -LiteralPath $skill) {
  $t = [IO.File]::ReadAllText($skill, [Text.Encoding]::UTF8)
  $t = $t.Replace("{{DASH_DIR}}", $InstallDir)
  [IO.File]::WriteAllText($skill, $t, (New-Object Text.UTF8Encoding($false)))
  Write-Host "[install] SKILL.md 路径已写入"
}

# 注册插件市场与插件
if (-not $NoPlugin) {
  $codex = (Get-Command codex -ErrorAction SilentlyContinue).Source
  if ($codex) {
    & $codex plugin marketplace add $InstallDir
    & $codex plugin add codex-token-usage@codex-token-usage
    Write-Host "[install] 插件已注册"
  } else {
    Write-Host "[install] 未找到 codex CLI，跳过插件注册（见 README 手动步骤）"
  }
}

# 写入开机自启（启动文件夹快捷方式）
if (-not $NoAutostart) {
  $startup = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
  $ws = New-Object -ComObject WScript.Shell
  $q = [string][char]34
  $map = @(@("Codex Token 悬浮条.lnk","widget-boot.vbs"), @("Codex Token 看护.lnk","watchdog-boot.vbs"))
  foreach ($pair in $map) {
    $lnk = $ws.CreateShortcut((Join-Path $startup $pair[0]))
    $lnk.TargetPath = "wscript.exe"
    $lnk.Arguments = $q + (Join-Path $InstallDir $pair[1]) + $q
    $lnk.WorkingDirectory = $InstallDir
    $lnk.Save()
  }
  Write-Host "[install] 已写入启动文件夹"
}

# 启动服务与守护
$boot = Join-Path $InstallDir "widget-boot.vbs"
& wscript.exe $boot

# 注册表 Run 兜底（与启动文件夹双保险）
if (-not $NoAutostart) {
  $q3 = [string][char]34
  $runKey = (@("HKCU:","Software","Microsoft","Windows","CurrentVersion","Run") -join "\")
  $runVal = "wscript.exe " + $q3 + (Join-Path $InstallDir "watchdog-boot.vbs") + $q3
  Set-ItemProperty -Path $runKey -Name "CodexTokenWatchdog" -Value $runVal
  Write-Host "[install] 已写入注册表 Run"
}

Write-Host "[install] 完成！看板 http://127.0.0.1:8788/"
Write-Host "[install] Codex 启动后悬浮条会自动出现（守护会自动带调试口重启 Codex）"