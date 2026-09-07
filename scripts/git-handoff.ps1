<#
.SYNOPSIS
  GitHub Vault Relay - Desktop Local Git Handoff Consumer (PowerShell)
.DESCRIPTION
  Reads the declarative git-handoff.json signal emitted by GitHub Vault Relay on Desktop,
  runs `git fetch` and `git reset --mixed` to align local .git metadata with the remote commit,
  and marks the handoff status as 'completed'.
.PARAMETER VaultPath
  Path to the Obsidian vault root directory (default: current directory).
#>

[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$VaultPath = "."
)

$ErrorActionPreference = "Stop"

# Resolve absolute path to the vault
$ResolvedVault = (Resolve-Path $VaultPath).Path
$ConfigDir = ".obsidian"
$HandoffFile = Join-Path $ResolvedVault "$ConfigDir/github-vault-relay/git-handoff.json"

if (-not (Test-Path $HandoffFile)) {
  Write-Host "[Git Handoff] No git-handoff.json signal found at $HandoffFile. Nothing to reconcile."
  exit 0
}

try {
  $Content = Get-Content -LiteralPath $HandoffFile -Raw -Encoding utf8
  $Handoff = $Content | ConvertFrom-Json
} catch {
  Write-Warning "[Git Handoff] Unable to parse $HandoffFile: $_"
  exit 1
}

if ($Handoff.status -ne "pending") {
  Write-Host "[Git Handoff] Signal status is '$($Handoff.status)'. No pending action required."
  exit 0
}

$Branch = $Handoff.branch
$CommitSha = $Handoff.remoteCommitSha

# Validate commit SHA format strictly (40-char hex)
if ($CommitSha -notmatch '^[0-9a-fA-F]{40}$') {
  Write-Error "[Git Handoff] Invalid commit SHA format: '$CommitSha'"
  exit 1
}

Write-Host "[Git Handoff] Reconciling local .git with remote commit $CommitSha on branch '$Branch'..."

Push-Location $ResolvedVault
try {
  # 1. Fetch remote commit object from GitHub
  Write-Host "[Git Handoff] Fetching objects from origin $Branch..."
  git fetch origin "$Branch" --quiet

  # 2. Verify commit object exists in local object store
  git cat-file -e "$CommitSha"

  # 3. Advance HEAD and Index without modifying working tree files
  Write-Host "[Git Handoff] Advancing HEAD and Index to $CommitSha..."
  git reset --mixed "$CommitSha"

  # 4. Mark handoff as completed
  $Handoff.status = "completed"
  $Handoff.appliedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  $Handoff.lastError = $null

  $UpdatedJson = $Handoff | ConvertTo-Json -Depth 4
  [System.IO.File]::WriteAllText($HandoffFile, $UpdatedJson, [System.Text.Encoding]::UTF8)

  Write-Host "[Git Handoff] Successfully reconciled local .git! Working tree is clean and up to date."
} catch {
  Write-Error "[Git Handoff] Failed to adopt remote commit: $_"
  try {
    $Handoff.status = "failed"
    $Handoff.lastError = "$_"
    $FailedJson = $Handoff | ConvertTo-Json -Depth 4
    [System.IO.File]::WriteAllText($HandoffFile, $FailedJson, [System.Text.Encoding]::UTF8)
  } catch {}
  exit 1
} finally {
  Pop-Location
}
