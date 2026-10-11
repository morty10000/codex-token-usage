# widget-boot.ps1 — 静默拉起 serve(8788) + widgetd 守护 (幂等, 可重复执行)
$ErrorActionPreference = 'SilentlyContinue'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir

# 解析 node.exe：优先 PATH，其次常见安装位置
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) {
  foreach ($c in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
    if ($c -and (Test-Path -LiteralPath $c)) { $node = $c; break }
  }
}
if (-not $node) {
  Add-Content -Path (Join-Path $dir 'widgetd.err.log') -Value ((Get-Date).ToString('s') + ' node.exe not found; install Node.js or add it to PATH')
  exit 1
}

# 1) serve: 数据导出 + 看板托管
$alive = $false
$c = New-Object Net.Sockets.TcpClient
try { $c.Connect('127.0.0.1', 8788); $alive = $true } catch {}
$c.Dispose()
if (-not $alive) {
  Start-Process $node -ArgumentList 'serve.mjs','--interval','300' -WorkingDirectory $dir -WindowStyle Hidden
}

# 2) widgetd: 注入守护 (重复实例会因控制口占用自行退出)
Start-Process $node -ArgumentList 'widgetd.mjs' -WorkingDirectory $dir -WindowStyle Hidden `
  -RedirectStandardOutput "$dir\widgetd.log" -RedirectStandardError "$dir\widgetd.err.log"