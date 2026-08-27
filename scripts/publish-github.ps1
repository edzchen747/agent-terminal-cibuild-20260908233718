param(
  [string]$Repository = 'edzchen747/agent-terminal'
)

$ErrorActionPreference = 'Stop'

$Gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $Gh) { $Gh = 'C:\Program Files\GitHub CLI\gh.exe' }
if (-not (Test-Path -LiteralPath $Gh)) { throw 'GitHub CLI was not found.' }

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $Root

function Invoke-GhJson([string]$Endpoint, [hashtable]$Body) {
  $json = $Body | ConvertTo-Json -Depth 10 -Compress
  $result = $json | & $Gh api -X POST $Endpoint --input -
  if ($LASTEXITCODE -ne 0) { throw "GitHub API request failed: $Endpoint" }
  return ($result | ConvertFrom-Json)
}

function Get-BlobSha([string]$RelativePath) {
  $fullPath = Join-Path $Root $RelativePath.Replace('/', '\')
  $base64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($fullPath))
  $body = @{ content = $base64; encoding = 'base64' } | ConvertTo-Json -Compress
  $sha = ($body | & $Gh api -X POST "repos/$Repository/git/blobs" --input - --jq '.sha').Trim()
  if ($LASTEXITCODE -ne 0 -or -not $sha) { throw "Could not upload $RelativePath" }
  return $sha
}

function Get-WorkspaceFiles {
  $files = & rg --files --hidden -g '!.git/**'
  if ($LASTEXITCODE -ne 0) { throw 'Could not enumerate the workspace.' }
  $included = [System.Collections.Generic.List[string]]::new()
  foreach ($relative in $files) {
    $relative = $relative.Replace('\', '/')
    & git check-ignore -q -- $relative
    $ignored = $LASTEXITCODE -eq 0
    if ($ignored) { continue }
    if ($relative -match '(^|/)(node_modules|\.git|\.tools|\.gh-config|\.npm-cache|\.electron-cache|\.electron-gyp|\.node-gyp|\.electron-builder-cache|out|dist|release|build|assets)(/|$)') { continue }
    $included.Add($relative)
  }
  return $included | Sort-Object
}

function New-Tree([object[]]$Entries, [string]$BaseTreeSha) {
  $body = @{ tree = @($Entries) }
  if ($BaseTreeSha) { $body.base_tree = $BaseTreeSha }
  return Invoke-GhJson "repos/$Repository/git/trees" $body
}

function New-Commit([string]$Message, [string]$TreeSha, [string]$ParentSha) {
  $body = @{ message = $Message; tree = $TreeSha; parents = @() }
  if ($ParentSha) { $body.parents = @($ParentSha) }
  return Invoke-GhJson "repos/$Repository/git/commits" $body
}

$files = @(Get-WorkspaceFiles)
$blobByPath = @{}
$entriesByStage = @(@(), @(), @(), @())

foreach ($relative in $files) {
  $stage = if (
    $relative -eq '.gitignore' -or
    $relative -eq 'package.json' -or
    $relative -eq 'package-lock.json' -or
    $relative -eq 'tsconfig.base.json' -or
    $relative.StartsWith('packages/protocol/')
  ) { 0 } elseif ($relative.StartsWith('apps/desktop/')) { 1 } elseif ($relative.StartsWith('apps/mobile/')) { 2 } elseif ($relative -eq 'README.md' -or $relative.StartsWith('docs/') -or $relative.StartsWith('scripts/')) { 3 } else { continue }

  $blobSha = Get-BlobSha $relative
  $blobByPath[$relative] = $blobSha
  $entriesByStage[$stage] += [ordered]@{ path = $relative; mode = '100644'; type = 'blob'; sha = $blobSha }
}

$messages = @(
  'chore: initialize monorepo and shared protocol',
  'feat(desktop): add ConPTY terminal host and pairing server',
  'feat(mobile): add Android-first remote terminal client',
  'docs: add setup architecture and security guidance'
)
$parentCommit = (& $Gh api "repos/$Repository/git/refs/heads/main" --jq '.object.sha').Trim()
if ($LASTEXITCODE -ne 0 -or -not $parentCommit) { throw 'Could not read the repository main branch.' }
$baseTree = (& $Gh api "repos/$Repository/git/commits/$parentCommit" --jq '.tree.sha').Trim()
if ($LASTEXITCODE -ne 0 -or -not $baseTree) { throw 'Could not read the repository base tree.' }
for ($stage = 0; $stage -lt 4; $stage++) {
  $tree = New-Tree $entriesByStage[$stage] $baseTree
  $commit = New-Commit $messages[$stage] $tree.sha $parentCommit
  $parentCommit = $commit.sha
  $baseTree = $tree.sha
  Write-Host "$($messages[$stage]) -> $($commit.sha)"
}

$refBody = @{ ref = 'refs/heads/main'; sha = $parentCommit }
$refJson = $refBody | ConvertTo-Json -Compress
$refJson | & $Gh api -X PATCH "repos/$Repository/git/refs/heads/main" --input - | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not update the main branch.' }
Write-Host "Published $Repository at https://github.com/$Repository"
