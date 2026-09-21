[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot "run-in-codex-poc.common.ps1")

try {
  Stop-PublishProcesses
  Unregister-ScheduledTask -TaskName $script:TaskName -Confirm:$false -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $script:DataHome) {
    Remove-Item -LiteralPath $script:DataHome -Recurse -Force
  }
  Write-Output "✅ Windows 发布版 Bridge、任务和运行目录已卸载。"
  Write-Output "原版 sol-codex-bridge、原版服务和共享 Pairing Token 未删除。"
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
