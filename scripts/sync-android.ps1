$ErrorActionPreference = 'Stop'

$WorkspaceRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $WorkspaceRoot
$env:npm_config_cache = Join-Path $WorkspaceRoot '.npm-cache'

if (-not (Get-Command java -ErrorAction SilentlyContinue)) {
  throw 'Java 21 is required. Install Android Studio (recommended) and expose its JBR on PATH.'
}

if (-not $env:ANDROID_HOME -and -not $env:ANDROID_SDK_ROOT) {
  throw 'Set ANDROID_HOME or ANDROID_SDK_ROOT to your Android SDK directory.'
}

npm run android:sync

