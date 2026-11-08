$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverScript = Join-Path $scriptDir "scripts\real-stage3-server.mjs"
Write-Host "Starting Host Browser Bridge from: $serverScript"
& "C:\nvm4w\nodejs\node.exe" $serverScript

