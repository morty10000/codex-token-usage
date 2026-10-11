# restart-codex.ps1 — 关闭 Codex 并带调试口重启（悬浮条注入依赖它）
$ErrorActionPreference = 'SilentlyContinue'

$exe = (Get-Process ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1).Path
if (-not $exe) {
  $pkg = Get-AppxPackage | Where-Object { $_.Name -like '*Codex*' } | Select-Object -First 1
  if ($pkg) { $exe = Join-Path $pkg.InstallLocation 'app\ChatGPT.exe' }
}
if (-not $exe) {
  $glob = Get-ChildItem 'C:\Program Files\WindowsApps\OpenAI.Codex_*\app\ChatGPT.exe' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($glob) { $exe = $glob.FullName }
}
if (-not $exe -or -not (Test-Path $exe)) { Write-Host '[restart] 找不到 ChatGPT.exe，请手动启动 Codex'; exit 1 }

Write-Host ('[restart] 正在关闭 Codex: ' + $exe)
Get-Process ChatGPT | Stop-Process -Force
Start-Sleep -Seconds 2
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $exe
$psi.Arguments = '--remote-debugging-port=9229 --remote-allow-origins=http://127.0.0.1:9229'
$psi.UseShellExecute = $false
$psi.WorkingDirectory = (Split-Path -Parent $exe)
try { [System.Diagnostics.Process]::Start($psi) | Out-Null } catch { Write-Host ('[restart] launch failed: ' + $_.Exception.Message) }
Write-Host '[restart] Codex 已带调试口重启，悬浮条几秒内自动出现'
