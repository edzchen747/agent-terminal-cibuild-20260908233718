param(
    [string]$KeyAlias = 'agent-terminal-release'
)

$ErrorActionPreference = 'Stop'

$workspaceRoot = Split-Path -Parent $PSScriptRoot
$keystoreDirectory = Join-Path $workspaceRoot 'apps\mobile\android\keystore'
$keystorePath = Join-Path $keystoreDirectory 'agent-terminal-release.jks'
$propertiesPath = Join-Path $workspaceRoot 'apps\mobile\android\keystore.properties'

$keytool = $null
if ($env:JAVA_HOME) {
    $javaHomeKeytool = Join-Path $env:JAVA_HOME 'bin\keytool.exe'
    if (Test-Path -LiteralPath $javaHomeKeytool) {
        $keytool = $javaHomeKeytool
    }
}
if (-not $keytool) {
    $keytoolCommand = Get-Command keytool -ErrorAction SilentlyContinue
    if ($keytoolCommand) {
        $keytool = $keytoolCommand.Source
    }
}
if (-not $keytool) {
    throw 'keytool was not found. Install a JDK (the Android Studio JDK is fine) and set JAVA_HOME or PATH.'
}

if ((Test-Path -LiteralPath $keystorePath) -or (Test-Path -LiteralPath $propertiesPath)) {
    throw "Android signing files already exist. Refusing to overwrite $keystorePath or $propertiesPath."
}
if ([string]::IsNullOrWhiteSpace($KeyAlias) -or $KeyAlias -match '[\s\\]') {
    throw 'KeyAlias must be non-empty and contain no whitespace or backslashes.'
}

$passwordSecure = Read-Host 'Enter the Android keystore/key password' -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($passwordSecure)
$password = $null

try {
    $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    if ([string]::IsNullOrWhiteSpace($password)) {
        throw 'The keystore/key password cannot be empty.'
    }
    if ($password -match '[\s\\]') {
        throw 'Use a keystore/key password without whitespace or backslashes so it can be stored safely in keystore.properties.'
    }

    New-Item -ItemType Directory -Path $keystoreDirectory -Force | Out-Null
    & $keytool -genkeypair `
        -v `
        -keystore $keystorePath `
        -storetype JKS `
        -storepass $password `
        -keypass $password `
        -alias $KeyAlias `
        -keyalg RSA `
        -keysize 4096 `
        -validity 10000 `
        -dname 'CN=Agent Terminal, OU=Mobile, O=Agent Terminal, C=GB'
    if ($LASTEXITCODE -ne 0) {
        throw "keytool failed with exit code $LASTEXITCODE."
    }

    @(
        "storeFile=keystore/agent-terminal-release.jks"
        "storePassword=$password"
        "keyAlias=$KeyAlias"
        "keyPassword=$password"
    ) | Set-Content -LiteralPath $propertiesPath -Encoding ascii

    Write-Output "Created local Android signing keystore: $keystorePath"
    Write-Output "Created ignored Gradle signing properties: $propertiesPath"
    Write-Output 'Back up the keystore and password securely; losing them prevents future APK updates.'
}
finally {
    if ($passwordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
    $password = $null
}
