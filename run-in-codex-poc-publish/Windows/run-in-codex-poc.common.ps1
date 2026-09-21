$ErrorActionPreference = "Stop"

$script:PublishRoot = Split-Path -Parent $PSScriptRoot
$script:Port = 4329
$script:TaskName = "Sol Codex POC Publish Bridge"
$script:DataHome = Join-Path $env:USERPROFILE ".sol-codex-run-in-codex-poc-publish"
$script:AppHome = Join-Path $script:DataHome "app"
$script:LauncherPath = Join-Path $script:AppHome "bridge-launcher.ps1"
$script:ConfigPath = Join-Path $script:DataHome "config.json"

function Get-NodePath {
  $candidates = @()
  $command = Get-Command node -ErrorAction SilentlyContinue
  if ($command) { $candidates += $command.Source }
  $candidates += @(
    (Join-Path $env:ProgramFiles "nodejs\node.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe")
  )
  return $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -Unique -First 1
}

function Get-BridgeRoot {
  $candidates = @()
  if ($env:SOL_CODEX_BRIDGE_ROOT) { $candidates += $env:SOL_CODEX_BRIDGE_ROOT }
  $candidates += (Join-Path $env:USERPROFILE ".sol-codex-bridge\app")
  $candidates += (Join-Path (Split-Path -Parent $script:PublishRoot) "sol-codex-bridge")
  return $candidates |
    Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ "bridge\lib\codex-cli.mjs") -PathType Leaf) } |
    Select-Object -Unique -First 1
}

function Get-ProjectPath {
  if ($env:C2C_PROJECT_PATH) { return $env:C2C_PROJECT_PATH }
  return ""
}

function Get-PortPids {
  try {
    return @(Get-NetTCPConnection -LocalPort $script:Port -State Listen -ErrorAction Stop |
      Select-Object -ExpandProperty OwningProcess | ForEach-Object { [int]$_ } |
      Sort-Object -Unique)
  } catch {
    return @((& netstat.exe -ano -p TCP 2>$null) | ForEach-Object {
      if ($_ -match "^\s*TCP\s+\S+:$($script:Port)\s+\S+\s+LISTENING\s+(\d+)\s*$") { [int]$Matches[1] }
    } | Sort-Object -Unique)
  }
}

function Get-PublishProcesses {
  $needle = $script:AppHome.ToLowerInvariant()
  return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessId -and $_.CommandLine -and
    $_.CommandLine.ToLowerInvariant().Contains($needle) -and
    $_.CommandLine.ToLowerInvariant().Contains("server.mjs")
  })
}

function Assert-PortSafe {
  $owned = @(Get-PublishProcesses | Select-Object -ExpandProperty ProcessId)
  foreach ($pid in @(Get-PortPids)) {
    if ($owned -notcontains $pid) {
      $name = (Get-Process -Id $pid -ErrorAction SilentlyContinue).ProcessName
      throw "端口 $($script:Port) 已被其他进程占用：PID $pid ($name)。未终止该进程。"
    }
  }
}

function Stop-PublishProcesses {
  try { Stop-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue } catch {}
  foreach ($process in @(Get-PublishProcesses)) {
    Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
  }
  for ($i = 0; $i -lt 20 -and @(Get-PublishProcesses).Count -gt 0; $i++) {
    Start-Sleep -Milliseconds 150
  }
}

function Test-Health {
  try { return Invoke-RestMethod -Uri "http://127.0.0.1:$($script:Port)/health" -TimeoutSec 2 } catch { return $null }
}

function Wait-Health {
  for ($i = 0; $i -lt 40; $i++) {
    $health = Test-Health
    if ($health -and $health.ok) { return $health }
    Start-Sleep -Milliseconds 250
  }
  return $null
}

function Get-Task {
  return Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
}

function Write-RuntimeConfig($NodePath, $BridgeRoot, $ProjectPath) {
  New-Item -ItemType Directory -Path $script:DataHome -Force | Out-Null
  New-Item -ItemType Directory -Path $script:AppHome -Force | Out-Null
  [ordered]@{
    NodePath = $NodePath
    BridgeRoot = $BridgeRoot
    ProjectPath = $ProjectPath
  } | ConvertTo-Json | Set-Content -LiteralPath $script:ConfigPath -Encoding UTF8
}

function Install-RuntimeFiles {
  $sourceBridge = Join-Path $script:PublishRoot "bridge"
  if (-not (Test-Path -LiteralPath (Join-Path $sourceBridge "server.mjs") -PathType Leaf)) {
    throw "找不到发布版 Bridge：$sourceBridge"
  }
  New-Item -ItemType Directory -Path $script:AppHome -Force | Out-Null
  Get-ChildItem -LiteralPath $sourceBridge -Force | Copy-Item -Destination $script:AppHome -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot "bridge-launcher.ps1") -Destination $script:LauncherPath -Force
}

function Register-PublishTask {
  $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
  $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $script:LauncherPath
  $action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType InteractiveToken -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $script:TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
}

function Start-PublishTask {
  if (-not (Get-Task)) { throw "未找到任务计划程序任务，请先运行安装脚本。" }
  Start-ScheduledTask -TaskName $script:TaskName
}

function Copy-PairingToken {
  $tokenPath = Join-Path $env:USERPROFILE ".sol-codex-bridge\token"
  if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) {
    Write-Warning "未找到共享 Pairing Token：$tokenPath。请先安装原版 sol-codex-bridge。"
    return
  }
  $token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
  if (-not $token) { Write-Warning "Pairing Token 为空：$tokenPath"; return }
  try { Set-Clipboard -Value $token } catch { $token | clip.exe }
  Write-Output "Pairing Token 已复制到剪贴板。"
}
