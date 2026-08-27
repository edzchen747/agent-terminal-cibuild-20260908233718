$ErrorActionPreference = 'Stop'

$WorkspaceRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $WorkspaceRoot

$env:npm_config_cache = Join-Path $WorkspaceRoot '.npm-cache'
$env:electron_config_cache = Join-Path $WorkspaceRoot '.electron-cache'
$env:ELECTRON_BUILDER_CACHE = Join-Path $WorkspaceRoot '.electron-builder-cache'

npm run package:win -w '@agentterminal/desktop'

