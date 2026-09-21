$ErrorActionPreference = "Stop"

$dataHome = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $dataHome "config.json"
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$env:SOL_CODEX_BRIDGE_ROOT = [string]$config.BridgeRoot
if ([string]$config.ProjectPath) { $env:C2C_PROJECT_PATH = [string]$config.ProjectPath }
$serverPath = Join-Path $PSScriptRoot "bridge\server.mjs"
$logPath = Join-Path $dataHome "bridge.log"
$errorLogPath = Join-Path $dataHome "bridge.error.log"

& ([string]$config.NodePath) $serverPath 1>> $logPath 2>> $errorLogPath
exit $LASTEXITCODE
