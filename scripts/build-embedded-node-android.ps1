$ErrorActionPreference = 'Stop'

$WorkspaceRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $WorkspaceRoot

if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
  throw 'Go 1.24 or newer is required to build the Android embedded node.'
}

$OutputDirectory = Join-Path $WorkspaceRoot 'apps\mobile\android\app\src\main\assets\embedded-node\arm64-v8a'
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

$previousGoOs = $env:GOOS
$previousGoArch = $env:GOARCH
$previousCgo = $env:CGO_ENABLED
try {
  $env:GOOS = 'android'
  $env:GOARCH = 'arm64'
  $env:CGO_ENABLED = '0'
  go build -trimpath -ldflags='-s -w' -o (Join-Path $OutputDirectory 'embedded-node') .\apps\embedded-node
} finally {
  $env:GOOS = $previousGoOs
  $env:GOARCH = $previousGoArch
  $env:CGO_ENABLED = $previousCgo
}
