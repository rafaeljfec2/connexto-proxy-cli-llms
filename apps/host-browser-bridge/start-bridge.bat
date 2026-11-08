@echo off
set BROWSER_BRIDGE_TOKEN=stage3-secure-token-xyz
set BROWSER_BRIDGE_PORT=4318
echo Starting Host Browser Bridge on port %BROWSER_BRIDGE_PORT%...
"C:\nvm4w\nodejs\node.exe" "%~dp0scripts\real-stage3-server.mjs"

