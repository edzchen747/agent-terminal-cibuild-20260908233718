$ErrorActionPreference = 'Stop'

$WorkspaceRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $WorkspaceRoot

$env:npm_config_cache = Join-Path $WorkspaceRoot '.npm-cache'
$env:electron_config_cache = Join-Path $WorkspaceRoot '.electron-cache'

npm install
node (Join-Path $WorkspaceRoot 'node_modules/electron/install.js')
npm run build

Write-Host 'Agent Terminal is ready. Run npm run dev to launch the desktop app.' -ForegroundColor Green

