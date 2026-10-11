# token-watchdog: keeps serve (8788) + widgetd (8791) alive; watches Codex debug port.
# Turn off: create file "watchdog.off" in this folder (widget-off.bat does it).
$ErrorActionPreference = 'SilentlyContinue'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$off = Join-Path $dir 'watchdog.off'
$log = Join-Path $dir 'watchdog.log'
$listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 8792)
try { $listener.Start() } catch { exit }
function Test-Port([int]$port) {
  $c = New-Object Net.Sockets.TcpClient
  try { $c.Connect('127.0.0.1', $port); $c.Dispose(); return $true } catch { try { $c.Dispose() } catch {}; return $false }
}
function Note([string]$msg) { Add-Content -Path $log -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $msg) }
function Show-Toast([string]$title, [string]$msg) {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>' + $title + '</text><text>' + $msg + '</text></binding></visual></toast>')
  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('CodexToken').Show($toast)
}
function Resolve-CodexExe() {
  $p = Get-Process ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1
  if ($p) { return $p.Path }
  $glob = Get-ChildItem 'C:\Program Files\WindowsApps\OpenAI.Codex_*\app\ChatGPT.exe' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($glob) { return $glob.FullName }
  return $null
}
function Restart-Codex() {
  $exe = Resolve-CodexExe
  if (-not $exe -or -not (Test-Path -LiteralPath $exe)) { Note 'restart: exe-not-found'; return }
  Note ('restart: closing Codex, exe=' + $exe)
  Get-Process ChatGPT -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.Arguments = '--remote-debugging-port=9229 --remote-allow-origins=http://127.0.0.1:9229'
  $psi.UseShellExecute = $false
  $psi.WorkingDirectory = (Split-Path -Parent $exe)
  try { [System.Diagnostics.Process]::Start($psi) | Out-Null; Note 'restart: launched via CreateProcess' } catch { Note ('restart: launch FAILED: ' + $_.Exception.Message) }
}
Note 'watchdog up'
$badN = 0
$notified = $false
$lastRestart = [datetime]::MinValue
while ($true) {
  if (Test-Path -LiteralPath $off) { Note 'off-by-user, exit'; exit }
  $s = Test-Port 8788
  $w = Test-Port 8791
  if ((-not $s) -or (-not $w)) {
    if (Test-Path -LiteralPath $off) { Note 'off-by-user, exit'; exit }
    Note ('heal: serve=' + $s + ' widgetd=' + $w)
    $boot = Join-Path $dir 'widget-boot.ps1'
    Start-Process powershell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $boot + '"')) -WindowStyle Hidden
  }
  $hasApp = $null -ne (Get-Process ChatGPT -ErrorAction SilentlyContinue)
  if ($hasApp -and (-not (Test-Port 9229))) {
    $badN++
    if (($badN -ge 3) -and (-not $notified) -and (((Get-Date) - $lastRestart).TotalSeconds -gt 600)) {
      $notified = $true
      $lastRestart = Get-Date
      Note 'codex-no-debug-port: auto-restart'
      try { Show-Toast 'Token 悬浮条' 'Codex 未带调试口启动，正在自动重启以恢复悬浮条。' } catch { Note ('toast-fail: ' + $_.Exception.Message) }
      Restart-Codex
    }
  } else {
    $badN = 0
    $notified = $false
  }
  Start-Sleep -Seconds 15
}
