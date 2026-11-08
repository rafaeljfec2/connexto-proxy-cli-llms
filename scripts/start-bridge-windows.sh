#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WIN_PATH=$(wslpath -w "$REPO_ROOT/apps/host-browser-bridge/start-bridge.bat")

echo "Iniciando Host Browser Bridge no Windows..."
powershell.exe -NoProfile -NonInteractive -Command "
  Get-NetTCPConnection -LocalPort 4318 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force }
  Start-Process cmd.exe -ArgumentList '/c \"$WIN_PATH\"' -WindowStyle Hidden
" < /dev/null

echo "Verificando se o bridge subiu na porta 4318..."
for i in {1..10}; do
  if curl -s -f http://127.0.0.1:4318/health > /dev/null 2>&1 || curl -s -f "http://$(ip route | awk '/default/ {print $3}'):4318/health" > /dev/null 2>&1; then
    echo "Host Browser Bridge está ativo e pronto!"
    exit 0
  fi
  sleep 0.5
done

echo "Aviso: O bridge foi iniciado, mas ainda não respondeu ao healthcheck na porta 4318."

