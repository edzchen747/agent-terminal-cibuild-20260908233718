$ErrorActionPreference = 'Stop'

$WorkspaceRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $WorkspaceRoot

$env:npm_config_cache = Join-Path $WorkspaceRoot '.npm-cache'
$env:CARGO_HOME = Join-Path $WorkspaceRoot '.cargo-home'

powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-embedded-node.ps1
# The desktop consumes the protocol package's compiled dist, so rebuild it
# first: a stale dist breaks the desktop Vite build with missing exports.
npm run build -w '@agentterminal/protocol'
npm run package:win -w '@agentterminal/desktop'

$PortableNodeDirectory = Join-Path $WorkspaceRoot 'apps\desktop\src-tauri\target\release\embedded-node'
New-Item -ItemType Directory -Force -Path $PortableNodeDirectory | Out-Null
Copy-Item (Join-Path $WorkspaceRoot 'apps\desktop\src-tauri\resources\embedded-node\embedded-node.exe') (Join-Path $PortableNodeDirectory 'embedded-node.exe') -Force
