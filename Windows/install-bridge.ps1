[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$Port = 37821
$TaskName = "Sol Codex Local Bridge"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$DataHome = Join-Path $env:USERPROFILE ".sol-codex-bridge"
$AppHome = Join-Path $DataHome "app"
$ServerPath = Join-Path $AppHome "server.mjs"

function Get-NodePath {
  $candidates = @()
  $command = Get-Command node -ErrorAction SilentlyContinue
  if ($command) { $candidates += $command.Source }
  $candidates += @(
    (Join-Path $env:ProgramFiles "nodejs\node.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe")
  )
  return $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
}

function Get-CodexPath {
  $home = $env:USERPROFILE
  $appData = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $home "AppData\Roaming" }
  $candidates = @()
  if ($env:CODEX_BIN) {
    if (Test-Path -LiteralPath $env:CODEX_BIN -PathType Leaf) { $candidates += $env:CODEX_BIN }
    else {
      $command = Get-Command $env:CODEX_BIN -ErrorAction SilentlyContinue
      if ($command) { $candidates += $command.Source }
    }
  }
  $candidates += @(& where.exe codex 2>$null)
  $candidates += @(
    (Join-Path $appData "npm\codex.cmd"),
    (Join-Path $home ".npm-global\codex.cmd"),
    (Join-Path $home ".npm-global\bin\codex.cmd"),
    (Join-Path $home ".local\bin\codex.exe"),
    (Join-Path $home ".local\bin\codex.cmd"),
    (Join-Path $home ".local\bin\codex")
  )
  return $candidates |
    Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } |
    Select-Object -Unique | Select-Object -First 1
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
  return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessId -and $_.CommandLine -and
    $_.CommandLine.ToLowerInvariant().Contains($needle) -and
    $_.CommandLine.ToLowerInvariant().Contains("server.mjs")
  })
}

function Stop-BridgeProcesses {
  foreach ($process in @(Get-BridgeProcesses)) {
    Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
  }
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
  $node = Get-NodePath
  if (-not $node) { throw "未找到 Node.js。请先安装 Node.js 18+。" }
  $nodeVersion = (& $node --version 2>$null | Select-Object -First 1)
  if ($nodeVersion -notmatch '^v?(\d+)') { throw "无法读取 Node.js 版本。" }
  if ([int]$Matches[1] -lt 18) { throw "Node.js 版本过低：$nodeVersion，需要 18+。" }

  $codex = Get-CodexPath
  New-Item -ItemType Directory -Path $DataHome -Force | Out-Null
  New-Item -ItemType Directory -Path $AppHome -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $DataHome "node-path") -Value $node -Encoding ASCII
  if ($codex) { Set-Content -LiteralPath (Join-Path $DataHome "codex-bin") -Value $codex -Encoding ASCII }

  $tokenPath = Join-Path $DataHome "token"
  $token = if (Test-Path -LiteralPath $tokenPath -PathType Leaf) { (Get-Content -LiteralPath $tokenPath -Raw).Trim() } else { "" }
  if ($token.Length -lt 24) {
    $bytes = New-Object byte[] 24
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $token = ([BitConverter]::ToString($bytes)).Replace("-", "").ToLowerInvariant()
    Set-Content -LiteralPath $tokenPath -Value $token -Encoding ASCII
  }

  $portPids = @(Get-PortPids)
  foreach ($ownerPid in $portPids) {
    if (-not (@(Get-BridgeProcesses).ProcessId -contains $ownerPid)) {
      $name = (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue).ProcessName
      throw "端口 $Port 已被其他进程占用：PID $ownerPid ($name)。未终止该进程。"
    }
  }
  try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
  Stop-BridgeProcesses

  $sourceBridge = Join-Path $RepoRoot "bridge"
  Get-ChildItem -LiteralPath $sourceBridge -Force | Copy-Item -Destination $AppHome -Recurse -Force

  $action = New-ScheduledTaskAction -Execute $node -Argument ('"{0}"' -f $ServerPath)
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
  $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType InteractiveToken -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName

  $health = Wait-Health
  if (-not $health) {
    $detail = (Get-Content -LiteralPath (Join-Path $DataHome "bridge.error.log") -Tail 30 -ErrorAction SilentlyContinue) -join "`n"
    throw "Bridge 启动失败。$detail"
  }

  try { Set-Clipboard -Value $token } catch { $token | & clip.exe }
  Write-Output "✅ Sol → Codex Local Bridge 已安装并启动"
  Write-Output "Bridge: http://127.0.0.1:$Port"
  Write-Output "Node.js: $node $nodeVersion"
  if ($codex) { Write-Output "Codex CLI: $codex" } else { Write-Output "⚠️ 暂未找到 Codex CLI；可稍后在 Bridge 配置中补充 CODEX_BIN。" }
  Write-Output ("Health: platform={0}, cliAvailable={1}, desktopAvailable={2}" -f $health.platform, $health.cliAvailable, $health.desktopAvailable)
  Write-Output "Pairing Token 已复制到剪贴板。"
  Write-Output "任务计划程序：$TaskName（当前用户登录时启动）"
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
