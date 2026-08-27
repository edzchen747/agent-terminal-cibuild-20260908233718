$ErrorActionPreference = 'Stop'

$WorkspaceRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $WorkspaceRoot

$env:npm_config_cache = Join-Path $WorkspaceRoot '.npm-cache'
$env:CARGO_HOME = Join-Path $WorkspaceRoot '.cargo-home'

npm run package:win -w '@agentterminal/desktop'
