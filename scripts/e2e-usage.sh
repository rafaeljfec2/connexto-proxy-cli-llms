#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
ENDPOINT="${ENDPOINT:-/v1/providers/antigravity/usage}"
FULL_URL="$BASE_URL$ENDPOINT"

# Optional gateway API key
if [[ -n "${GATEWAY_API_TOKEN:-}" ]]; then
  AUTH_HEADER="-H \"x-gateway-api-key: $GATEWAY_API_TOKEN\""
elif [[ -n "${AIHUB_GATEWAY_API_KEY:-}" ]]; then
  AUTH_HEADER="-H \"x-gateway-api-key: $AIHUB_GATEWAY_API_KEY\""
else
  AUTH_HEADER=""
fi

echo "Running E2E test against $FULL_URL"

# Perform request with optional auth header
response=$(eval "curl -s $AUTH_HEADER -w \"\n%{http_code}\" \"$FULL_URL\"")
body=$(echo "$response" | sed '$d')
code=$(echo "$response" | tail -n1)

echo "HTTP status: $code"
if [ "$code" -ne 200 ]; then
  echo "Expected status 200, got $code"
  exit 1
fi

# Basic JSON validation using jq (if installed)
if command -v jq > /dev/null; then
  echo "$body" | jq . > /dev/null
  echo "Response is valid JSON"
  # Check required fields
  required=(provider status source fetched_at)
  for key in "${required[@]}"; do
    if ! echo "$body" | jq -e ".${key}" > /dev/null; then
      echo "Missing required field: $key"
      exit 1
    fi
  done
  echo "All required fields present"
else
  echo "jq not installed, skipping JSON content validation"
fi

echo "E2E test passed"
