#!/bin/zsh
# 中途挂了或代码更新：同步并重启。
exec "$(cd "$(dirname "$0")" && pwd)/run-in-codex-poc.command" restart
