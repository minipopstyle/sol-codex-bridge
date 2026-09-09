[CmdletBinding()]
param(
  [switch]$Purge
)

$ErrorActionPreference = "Stop"
$TaskName = "Sol Codex Local Bridge"
$DataHome = Join-Path $env:USERPROFILE ".sol-codex-bridge"
$AppHome = Join-Path $DataHome "app"

function Get-BridgeProcesses {
  $needle = $AppHome.ToLowerInvariant()
  return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessId -and $_.CommandLine -and
    $_.CommandLine.ToLowerInvariant().Contains($needle) -and
    $_.CommandLine.ToLowerInvariant().Contains("server.mjs")
  })
}

try {
  try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
  foreach ($process in @(Get-BridgeProcesses)) {
    Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
  }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $AppHome) { Remove-Item -LiteralPath $AppHome -Recurse -Force }

  if ($Purge) {
    if (Test-Path -LiteralPath $DataHome) { Remove-Item -LiteralPath $DataHome -Recurse -Force }
    Write-Output "✅ Bridge、任务和用户配置已删除。"
  } else {
    Write-Output "✅ Bridge、任务和 app 文件已删除。"
    Write-Output "用户配置与 Pairing Token 仍保留在 $DataHome。需要完全删除时重新运行：.\uninstall-bridge.ps1 -Purge"
  }
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
