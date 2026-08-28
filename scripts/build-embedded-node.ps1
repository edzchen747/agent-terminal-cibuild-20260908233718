$ErrorActionPreference = 'Stop'

$WorkspaceRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $WorkspaceRoot

if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
  throw 'Go 1.24 or newer is required to build the process-isolated embedded node.'
}

$OutputDirectory = Join-Path $WorkspaceRoot 'apps\desktop\src-tauri\resources\embedded-node'
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

go build -trimpath -ldflags='-s -w' -o (Join-Path $OutputDirectory 'embedded-node.exe') .\apps\embedded-node
