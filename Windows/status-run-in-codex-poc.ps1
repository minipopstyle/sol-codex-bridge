[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot "run-in-codex-poc.common.ps1")

$health = Test-Health
if ($health -and $health.ok) {
  Write-Output "POC Bridge：运行中（http://127.0.0.1:$($script:Port)）"
} else {
  Write-Output "POC Bridge：未运行"
}

$task = Get-Task
if ($task) {
  $info = Get-ScheduledTaskInfo -TaskName $script:TaskName -ErrorAction SilentlyContinue
  Write-Output ("任务计划程序：{0}，上次运行：{1}，结果：{2}" -f $task.State, $info.LastRunTime, $info.LastTaskResult)
} else {
  Write-Output "任务计划程序：未安装"
}
Write-Output "运行目录：$($script:DataHome)"
