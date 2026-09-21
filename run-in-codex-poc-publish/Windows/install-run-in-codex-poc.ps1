[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot "run-in-codex-poc.common.ps1")

try {
  $node = Get-NodePath
  if (-not $node) { throw "未找到 Node.js。请先安装 Node.js 18+。" }
  $version = (& $node --version 2>$null | Select-Object -First 1)
  if ($version -notmatch '^v?(\d+)') { throw "无法读取 Node.js 版本。" }
  if ([int]$Matches[1] -lt 18) { throw "Node.js 版本过低：$version，需要 18+。" }

  $bridgeRoot = Get-BridgeRoot
  if (-not $bridgeRoot) { throw "找不到原版 sol-codex-bridge。请设置 SOL_CODEX_BRIDGE_ROOT 后重试。" }
  $projectPath = Get-ProjectPath
  Assert-PortSafe
  Stop-PublishProcesses
  Write-RuntimeConfig $node $bridgeRoot $projectPath
  Install-RuntimeFiles
  Register-PublishTask
  Start-PublishTask
  $health = Wait-Health
  if (-not $health) {
    $detail = (Get-Content -LiteralPath (Join-Path $script:DataHome "bridge.error.log") -Tail 30 -ErrorAction SilentlyContinue) -join "`n"
    throw "Bridge 启动失败。$detail"
  }

  Write-Output "✅ Windows 发布版 Bridge 已安装并启动"
  Write-Output "Bridge: http://127.0.0.1:$($script:Port)"
  Write-Output "Node.js: $node $version"
  Write-Output "任务计划程序：$($script:TaskName)（当前用户登录时启动）"
  Copy-PairingToken
  Write-Output "关闭 PowerShell 窗口不会停止 Bridge。"
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
