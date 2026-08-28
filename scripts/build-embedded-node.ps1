$ErrorActionPreference = 'Stop'

$WorkspaceRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $WorkspaceRoot

if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
  throw 'Go 1.24 or newer is required to build the process-isolated embedded node.'
}

$OutputDirectory = Join-Path $WorkspaceRoot 'apps\desktop\src-tauri\resources\embedded-node'
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

$EmbeddedNodeDirectory = Join-Path $WorkspaceRoot 'apps\embedded-node'
Push-Location -LiteralPath $EmbeddedNodeDirectory
try {
  # Build as a GUI-subsystem executable so Windows does not create a console
  # window when the Tauri GUI launches the process.
  go build -trimpath -ldflags='-s -w -H=windowsgui' -o (Join-Path $OutputDirectory 'embedded-node.exe') .
} finally {
  Pop-Location
}
