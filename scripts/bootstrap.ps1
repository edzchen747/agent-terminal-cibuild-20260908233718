$ErrorActionPreference = 'Stop'

$WorkspaceRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $WorkspaceRoot

$env:npm_config_cache = Join-Path $WorkspaceRoot '.npm-cache'
$env:CARGO_HOME = Join-Path $WorkspaceRoot '.cargo-home'

npm install
npm run build
cargo check --manifest-path (Join-Path $WorkspaceRoot 'apps\desktop\src-tauri\Cargo.toml')

Write-Host 'Agent Terminal is ready. Run npm run dev to launch the desktop app.' -ForegroundColor Green
