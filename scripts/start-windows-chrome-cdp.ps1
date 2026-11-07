# Run in Windows PowerShell before Hub "Login web" when CHROMIUM_CDP_ENDPOINT is set.
$profileDir = Join-Path $env:LOCALAPPDATA "ConnextoChromeProfile"
$chrome = Join-Path ${env:ProgramFiles} "Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) {
  Write-Error "Chrome not found at $chrome"
  exit 1
}
Write-Host "Starting Chrome with CDP on 0.0.0.0:9222 (profile: $profileDir)"
Write-Host "From WSL test: curl http://10.255.255.254:9222/json/version"
& $chrome `
  --remote-debugging-port=9222 `
  --remote-debugging-address=0.0.0.0 `
  --user-data-dir="$profileDir"
