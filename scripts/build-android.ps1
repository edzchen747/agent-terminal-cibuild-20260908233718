# Builds the Agent Terminal Android APK locally.
#
# Release (default): requires the four signing secrets in the process
# environment, exactly as the Android CI resolves them:
#   $env:ANDROID_KEYSTORE_BASE64  - base64-encoded release keystore (.jks)
#   $env:ANDROID_KEYSTORE_PASSWORD - keystore password
#   $env:ANDROID_KEY_ALIAS         - key alias inside the keystore
#   $env:ANDROID_KEY_PASSWORD      - private key password for the alias
# The keystore is decoded to apps/mobile/android/keystore/<name>.jks and the
# passwords flow to Gradle through environment variables (never written to
# disk, never echoed).
#
# Debug (-Debug): skips signing and builds a sideloadable app-debug.apk.
#
# Usage:
#   ./scripts/build-android.ps1
#   ./scripts/build-android.ps1 -Debug
#   ./scripts/build-android.ps1 -JavaHome "C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot"

param(
    [switch]$Debug,
    [string]$JavaHome,
    [string]$KeyStoreName = "agent-terminal-release.jks"
)

$ErrorActionPreference = "Stop"
$WorkspaceRoot = Split-Path -Parent $PSScriptRoot
$AndroidDir = Join-Path $WorkspaceRoot "apps\mobile\android"
$MobileDir = Join-Path $WorkspaceRoot "apps\mobile"

# ---------------------------------------------------------------- JDK ----
# Gradle 8.x needs a launcher JDK that understands the build scripts, and the
# Capacitor plugin toolchains want Java 21. Prefer an explicit -JavaHome, then
# a JDK 21 install, then a 17+ JAVA_HOME; the Android Studio JBR can be newer
# than Gradle supports (Java 25 breaks 8.14), so it is not auto-used.
function Find-JdkHome {
    param([string]$Preferred)
    $candidates = @()
    if ($Preferred) { $candidates += $Preferred }
    if ($env:JAVA_HOME) { $candidates += $env:JAVA_HOME }
    $candidates += (Get-ChildItem "C:\Program Files\Eclipse Adoptium" -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
    $candidates += (Get-ChildItem "$env:USERPROFILE\Playground" -Directory -Filter "jdk-*" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
    foreach ($candidate in $candidates) {
        if (-not (Test-Path (Join-Path $candidate "bin\java.exe"))) { continue }
        # java -version writes to stderr; under -ErrorAction Stop the 2>&1
        # capture would otherwise surface as a terminating NativeCommandError.
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        $version = & (Join-Path $candidate "bin\java.exe") -version 2>&1 | Select-String -Pattern 'version "([0-9]+)' -AllMatches
        $ErrorActionPreference = $previousPreference
        if ($version -and $version.Matches.Count -gt 0) {
            $major = [int]$version.Matches[0].Groups[1].Value
            # 21 is what the Android toolchain wants; 17/24 also run Gradle.
            if ($major -le 24) { return $candidate }
        }
    }
    throw "No usable JDK found. Install Java 21 (e.g. winget install EclipseAdoptium.Temurin.21.JDK) or pass -JavaHome."
}

$JdkHome = Find-JdkHome -Preferred $JavaHome
$env:JAVA_HOME = $JdkHome
Write-Host "Using JDK: $JdkHome"

# ------------------------------------------------------------- SDK ------
# local.properties is gitignored; create it from a known SDK location so
# Gradle can find android.jar, build-tools and the platform.
function Ensure-SdkDir {
    $candidates = @(
        "$env:USERPROFILE\Playground\android-sdk",
        "$env:LOCALAPPDATA\Android\Sdk",
        $env:ANDROID_SDK_ROOT,
        $env:ANDROID_HOME
    ) | Where-Object { $_ -and (Test-Path (Join-Path $_ "platforms")) }
    $sdk = $candidates | Select-Object -First 1
    if (-not $sdk) { throw "Android SDK not found. Install it or set ANDROID_HOME / -SdkDir." }
    $properties = Join-Path $AndroidDir "local.properties"
    $value = ($sdk -replace "\\", "/")
    Set-Content -LiteralPath $properties -Value "sdk.dir=$value" -Encoding ascii
    Write-Host "SDK: $sdk"
}

Ensure-SdkDir

# -------------------------------------------------- Embedded node ------
# The release artifacts need the process-isolated tsnet node in
# app/src/main/jniLibs/arm64-v8a. CI builds it from Go; if Go is installed
# here, rebuild it, otherwise keep whatever binary is already checked out
# (e.g. extracted from a CI APK or a previous build).
if (Get-Command go.exe -ErrorAction SilentlyContinue) {
    & (Join-Path $PSScriptRoot "build-embedded-node-android.ps1")
} else {
    Write-Host "Go not found - reusing the existing libembedded-node.so (if present)."
}

# The .so is gitignored, so a fresh checkout (or a machine without Go) can
# silently produce an APK without the embedded node. That build still works
# over LAN, but every phone's remote registration then fails with "Remote
# connection registration failed. LAN access is still available." - warn
# here instead of discovering it on the phone after installing the APK.
$EmbeddedNodeLib = Join-Path $AndroidDir "app\src\main\jniLibs\arm64-v8a\libembedded-node.so"
$EmbeddedNodeMissing = -not (Test-Path $EmbeddedNodeLib)
if ($EmbeddedNodeMissing) {
    Write-Warning "libembedded-node.so is missing (app\src\main\jniLibs\arm64-v8a)."
    Write-Warning "This APK will be built without the process-isolated tsnet node: the LAN connection keeps working, but remote (off-LAN) registration on the phone will fail."
    Write-Warning "Install Go 1.24+ and run scripts\build-embedded-node-android.ps1, or restore the .so from a previous build or a CI APK, then rebuild."
}

# ------------------------------------------------------- Web layer -----
Write-Host "Building web layer and syncing Capacitor..."
& npm.cmd "run" "android:sync" --prefix $MobileDir
if ($LASTEXITCODE -ne 0) { throw "android:sync failed (build the @agentterminal/protocol workspace first: npm run build -w @agentterminal/protocol)." }

# ------------------------------------------------------------- Gradle --
# The signing values may live in the process environment, or (as CI and a
# user-level setx do) in the User registry scope. Read either; the values get
# copied into $env: for Gradle regardless.
function Get-SigningSecret {
    param([string]$Name)
    $value = [Environment]::GetEnvironmentVariable($Name, "Process")
    if ([string]::IsNullOrEmpty($value)) {
        $value = [Environment]::GetEnvironmentVariable($Name, "User")
    }
    return $value
}

$RequiredKeys = @("ANDROID_KEYSTORE_BASE64", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD")
if ($Debug) {
    Push-Location $AndroidDir
    try { & .\gradlew.bat "assembleDebug" "--no-daemon" }
    finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "Gradle assembleDebug failed." }
    $Apk = Join-Path $AndroidDir "app\build\outputs\apk\debug\app-debug.apk"
} else {
    $Missing = @($RequiredKeys | Where-Object { [string]::IsNullOrEmpty((Get-SigningSecret $_)) })
    if ($Missing.Count -gt 0) {
        $MissingNames = $Missing -join ", "
        throw "Missing signing secret(s): $MissingNames. Set them in the environment (e.g. `$env:ANDROID_KEYSTORE_BASE64) or the User registry scope, or build with -Debug."
    }
    foreach ($key in $RequiredKeys) {
        Set-Item -Path ("env:" + $key) -Value (Get-SigningSecret $key)
    }
    $KeystoreDir = Join-Path $AndroidDir "keystore"
    New-Item -ItemType Directory -Force -Path $KeystoreDir | Out-Null
    $KeystorePath = Join-Path $KeystoreDir $KeyStoreName
    [byte[]]$KeystoreBytes = [Convert]::FromBase64String($env:ANDROID_KEYSTORE_BASE64)
    [IO.File]::WriteAllBytes($KeystorePath, $KeystoreBytes)
    Write-Host "Keystore restored: $KeystorePath"

    # Pass the signing values to Gradle through the environment only; build.gradle
    # reads ANDROID_KEYSTORE_PATH / PASSWORD / ALIAS / KEY_PASSWORD directly.
    $env:ANDROID_KEYSTORE_PATH = $KeystorePath
    Push-Location $AndroidDir
    try { & .\gradlew.bat "assembleRelease" "--no-daemon" "-PrequireReleaseSigning=true" }
    finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "Gradle assembleRelease failed." }
    $Apk = Join-Path $AndroidDir "app\build\outputs\apk\release\app-release.apk"
}

Write-Host ""
if (Test-Path $Apk) {
    Write-Host "APK ready: $Apk"
    if ($EmbeddedNodeMissing) {
        Write-Host "WARNING: built without libembedded-node.so - the phone will stay LAN-only until this APK is rebuilt with the embedded node."
    }
    Write-Host "Install with: adb install -r `"$Apk`""
} else {
    Write-Warning "APK not found at the expected path: $Apk"
}
