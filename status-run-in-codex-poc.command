#!/bin/zsh
# 只查看状态，不安装、不启动、不停止。
exec "$(cd "$(dirname "$0")" && pwd)/run-in-codex-poc.command" status
