[CmdletBinding()]
param()

$ErrorActionPreference = "SilentlyContinue"
$Port = 37821
$TaskName = "Sol Codex Local Bridge"
$DataHome = Join-Path $env:USERPROFILE ".sol-codex-bridge"
$AppHome = Join-Path $DataHome "app"

function Get-NodePath {
  $saved = Join-Path $DataHome "node-path"
  if (Test-Path -LiteralPath $saved -PathType Leaf) {
    $value = (Get-Content -LiteralPath $saved -Raw).Trim()
    if (Test-Path -LiteralPath $value -PathType Leaf) { return $value }
  }
  $command = Get-Command node -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  return "not found"
}

function Get-CodexPath {
  $saved = Join-Path $DataHome "codex-bin"
  if (Test-Path -LiteralPath $saved -PathType Leaf) {
    $value = (Get-Content -LiteralPath $saved -Raw).Trim()
    if (Test-Path -LiteralPath $value -PathType Leaf) { return $value }
  }
  $command = Get-Command codex -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  return "not found"
}

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
  return @(Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -and $_.CommandLine -and
    $_.CommandLine.ToLowerInvariant().Contains($needle) -and
    $_.CommandLine.ToLowerInvariant().Contains("server.mjs")
  })
}

Write-Output "=== Sol → Codex Bridge Diagnose ==="
$osInfo = Get-CimInstance Win32_OperatingSystem
Write-Output ("Windows Version: {0} ({1}, build {2})" -f $osInfo.Caption, $osInfo.Version, $osInfo.BuildNumber)
$node = Get-NodePath
Write-Output "Node Path: $node"
if ($node -ne "not found") { Write-Output ("Node Version: {0}" -f (& $node --version 2>$null | Select-Object -First 1)) } else { Write-Output "Node Version: not found" }
$codex = Get-CodexPath
Write-Output "Codex CLI Path: $codex"
if ($codex -ne "not found") { Write-Output ("Codex CLI Version: {0}" -f (& $codex --version 2>$null | Select-Object -First 1)) } else { Write-Output "Codex CLI Version: not found" }
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
$sqliteHome = if ($env:CODEX_SQLITE_HOME) { $env:CODEX_SQLITE_HOME } else { $codexHome }
Write-Output "Codex Home: $codexHome"
$stateCandidates = @(
  (Join-Path $sqliteHome "state_5.sqlite"),
  (Join-Path $codexHome "state_5.sqlite"),
  (Join-Path $env:APPDATA "Codex\state_5.sqlite"),
  (Join-Path $env:LOCALAPPDATA "Codex\state_5.sqlite")
)
$stateDb = $stateCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
Write-Output ("State DB: {0}" -f $(if ($stateDb) { $stateDb } else { "not found" }))
Write-Output "Bridge Home: $DataHome"
$bridgeProcesses = @(Get-BridgeProcesses)
Write-Output ("Bridge PID: {0}" -f $(if ($bridgeProcesses) { ($bridgeProcesses.ProcessId -join ", ") } else { "not found" }))

Write-Output "Port ${Port}:"
$portPids = @(Get-PortPids)
if ($portPids) {
  foreach ($ownerPid in $portPids) {
    $process = Get-Process -Id $ownerPid
    Write-Output ("  PID {0}  {1}" -f $ownerPid, $process.ProcessName)
  }
} else { Write-Output "  not listening" }

Write-Output "Health API:"
try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
  Write-Output ("  ok={0}, platform={1}, cliAvailable={2}, desktopAvailable={3}" -f $health.ok, $health.platform, $health.cliAvailable, $health.desktopAvailable)
  Write-Output ("  capabilities: {0}" -f (($health.capabilities.PSObject.Properties | Where-Object Value | ForEach-Object Name) -join ", "))
} catch { Write-Output "  unavailable" }

Write-Output "Task Scheduler:"
$task = Get-ScheduledTask -TaskName $TaskName
if ($task) {
  $taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName
  Write-Output ("  state={0}, lastRun={1}, lastResult={2}" -f $task.State, $taskInfo.LastRunTime, $taskInfo.LastTaskResult)
} else { Write-Output "  not found" }

foreach ($log in @("bridge.log", "bridge.error.log")) {
  $logPath = Join-Path $DataHome $log
  Write-Output "--- $log ---"
  if (Test-Path -LiteralPath $logPath -PathType Leaf) { Get-Content -LiteralPath $logPath -Tail 50 } else { Write-Output "not found" }
}
