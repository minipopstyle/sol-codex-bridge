[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$Port = 37821
$TaskName = "Sol Codex Local Bridge"
$DataHome = Join-Path $env:USERPROFILE ".sol-codex-bridge"
$AppHome = Join-Path $DataHome "app"

function Get-PortPids {
  try {
    return @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
      Select-Object -ExpandProperty OwningProcess | ForEach-Object { [int]$_ } |
      Sort-Object -Unique)
  } catch {
    return @((& netstat.exe -ano -p TCP 2>$null) | ForEach-Object {
      if ($_ -match "^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$") { [int]$Matches[1] }
    } | Sort-Object -Unique)
  }
}

function Get-BridgeProcesses {
  $needle = $AppHome.ToLowerInvariant()
  return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessId -and $_.CommandLine -and
    $_.CommandLine.ToLowerInvariant().Contains($needle) -and
    $_.CommandLine.ToLowerInvariant().Contains("server.mjs")
  })
}

function Test-Health {
  try { return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2 } catch { return $null }
}

function Wait-Health {
  for ($i = 0; $i -lt 40; $i++) {
    $health = Test-Health
    if ($health -and $health.ok) { return $health }
    Start-Sleep -Milliseconds 250
  }
  return $null
}

try {
  if (-not (Test-Path -LiteralPath (Join-Path $AppHome "server.mjs") -PathType Leaf)) {
    throw "Bridge 未安装完整，请先运行 install-bridge.ps1。"
  }

  $bridgeProcesses = @(Get-BridgeProcesses)
  foreach ($ownerPid in @(Get-PortPids)) {
    if (-not ($bridgeProcesses.ProcessId -contains $ownerPid)) {
      $name = (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue).ProcessName
      throw "端口 $Port 已被其他进程占用：PID $ownerPid ($name)。未终止该进程。"
    }
  }

  try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
  foreach ($process in $bridgeProcesses) {
    Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
  }
  for ($i = 0; $i -lt 20 -and @(Get-BridgeProcesses).Count -gt 0; $i++) {
    Start-Sleep -Milliseconds 150
  }

  if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
    throw "未找到任务计划程序任务 '$TaskName'，请先运行 install-bridge.ps1。"
  }
  Start-ScheduledTask -TaskName $TaskName
  $health = Wait-Health
  if (-not $health) {
    $detail = (Get-Content -LiteralPath (Join-Path $DataHome "bridge.error.log") -Tail 30 -ErrorAction SilentlyContinue) -join "`n"
    throw "Bridge 启动失败。$detail"
  }

  Write-Output "✅ Bridge 已重启"
  Write-Output ("Health: platform={0}, cliAvailable={1}, desktopAvailable={2}" -f $health.platform, $health.cliAvailable, $health.desktopAvailable)
  Write-Output "监听：127.0.0.1:$Port"
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
