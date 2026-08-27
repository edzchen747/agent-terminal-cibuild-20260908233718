param(
  [string]$Repository = 'edzchen747/agent-terminal',
  [string]$CommitMessage = 'chore: publish workspace'
)

$ErrorActionPreference = 'Stop'

$Gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $Gh) { $Gh = 'C:\Program Files\GitHub CLI\gh.exe' }
if (-not (Test-Path -LiteralPath $Gh)) { throw 'GitHub CLI was not found.' }

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $Root
if (-not $env:GH_CONFIG_DIR) { $env:GH_CONFIG_DIR = Join-Path $Root '.gh-config' }
if (-not $env:LOCALAPPDATA) { $env:LOCALAPPDATA = Join-Path $Root '.gh-cache' }

function Invoke-GhJson([string]$Endpoint, [string]$Method, [hashtable]$Body) {
  $json = $Body | ConvertTo-Json -Depth 20 -Compress
  $result = $json | & $Gh api -X $Method $Endpoint --input -
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
    & git -c "safe.directory=$Root" check-ignore -q -- $relative
    if ($LASTEXITCODE -eq 0) { continue }
    if ($relative -match '(^|/)(node_modules|\.git|\.tools|\.gh-config|\.gh-cache|\.npm-cache|\.electron-cache|\.electron-gyp|\.node-gyp|\.electron-builder-cache|out|dist|release|build|assets)(/|$)') { continue }
    $included.Add($relative)
  }
  return $included | Sort-Object
}

$parentCommit = (& $Gh api "repos/$Repository/git/refs/heads/main" --jq '.object.sha').Trim()
if ($LASTEXITCODE -ne 0 -or -not $parentCommit) { throw 'Could not read the repository main branch.' }
$baseTree = (& $Gh api "repos/$Repository/git/commits/$parentCommit" --jq '.tree.sha').Trim()
if ($LASTEXITCODE -ne 0 -or -not $baseTree) { throw 'Could not read the repository base tree.' }

$entries = [System.Collections.Generic.List[object]]::new()
$workspaceFiles = @(Get-WorkspaceFiles)
$workspacePaths = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($relative in $workspaceFiles) {
  [void]$workspacePaths.Add($relative)
  $entries.Add([ordered]@{
      path = $relative
      mode = '100644'
      type = 'blob'
      sha = Get-BlobSha $relative
    })
}

$remoteTreeJson = & $Gh api "repos/$Repository/git/trees/${baseTree}?recursive=1"
if ($LASTEXITCODE -ne 0) { throw 'Could not enumerate the repository base tree.' }
$remoteTree = $remoteTreeJson | ConvertFrom-Json
if ($remoteTree.truncated) { throw 'The repository tree is too large to publish safely.' }
foreach ($item in $remoteTree.tree) {
  if ($item.type -eq 'blob' -and -not $workspacePaths.Contains([string]$item.path)) {
    $entries.Add([ordered]@{
        path = [string]$item.path
        mode = '100644'
        type = 'blob'
        sha = $null
      })
  }
}

$tree = Invoke-GhJson "repos/$Repository/git/trees" 'POST' @{ base_tree = $baseTree; tree = @($entries) }
$commit = Invoke-GhJson "repos/$Repository/git/commits" 'POST' @{ message = $CommitMessage; tree = $tree.sha; parents = @($parentCommit) }
Invoke-GhJson "repos/$Repository/git/refs/heads/main" 'PATCH' @{ ref = 'refs/heads/main'; sha = $commit.sha } | Out-Null
Write-Host "Published $Repository at $($commit.sha)"
