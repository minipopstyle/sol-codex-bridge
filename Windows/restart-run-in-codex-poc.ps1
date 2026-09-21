[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot "run-in-codex-poc.common.ps1")

try {
  if (-not (Test-Path -LiteralPath $script:LauncherPath -PathType Leaf)) {
    throw "Windows 发布版未安装，请先运行 install-run-in-codex-poc.ps1。"
  }
  Assert-PortSafe
  Stop-PublishProcesses
  Start-PublishTask
  $health = Wait-Health
  if (-not $health) {
    $detail = (Get-Content -LiteralPath (Join-Path $script:DataHome "bridge.error.log") -Tail 30 -ErrorAction SilentlyContinue) -join "`n"
    throw "Bridge 重启失败。$detail"
  }
  Write-Output "✅ Windows 发布版 Bridge 已重启"
  Write-Output "监听：127.0.0.1:$($script:Port)"
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
