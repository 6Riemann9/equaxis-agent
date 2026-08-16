# start-pi-web.ps1 — 启动 pi-web（仓库版构建）
#
# 修复记录：旧版脚本设置了 $env:PI_CODING_AGENT_DIR="$HOME\.pi"，导致 pi-web 把数据目录
# 解析到 ~/.pi 根目录（而非 ~/.pi/agent），表现为：会话列表为空、模型面板无配置、
# 且会在 ~/.pi 根下生成垃圾文件。这里显式清除该变量，让 pi-web 回落默认 ~/.pi/agent。
#
# 注意：必须用仓库版构建（D:\test\mianshi\equaxis-agent\pi-web），它包含 Harness/Memory
# 面板路由；全局安装的 @agegr/pi-web 生产包不含这些路由（/api/harness 会 404）。
$ErrorActionPreference = "Stop"

Remove-Item Env:PI_CODING_AGENT_DIR -ErrorAction SilentlyContinue
Remove-Item Env:PI_CODING_AGENT_SESSION_DIR -ErrorAction SilentlyContinue

$piWebDir = Join-Path $PSScriptRoot "..\pi-web"
if (-not (Test-Path (Join-Path $piWebDir "bin\pi-web.js"))) {
    Write-Error "pi-web checkout not found at $piWebDir"
    exit 1
}

Set-Location $piWebDir
node .\bin\pi-web.js
