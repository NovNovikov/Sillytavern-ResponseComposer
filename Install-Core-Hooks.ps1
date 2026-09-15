[CmdletBinding()]
param(
    [string]$SillyTavernPath
)

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$patchDirectory = Join-Path $scriptRoot 'patches'
$expectedBaseCommit = '9d7e6ab64'

function Test-SillyTavernRoot {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $false
    }

    return (Test-Path (Join-Path $Path '.git')) -and
        (Test-Path (Join-Path $Path 'public\script.js') -PathType Leaf)
}

function Select-SillyTavernRoot {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = 'Select the SillyTavern source folder (it must contain .git and public\\script.js).'
    $dialog.ShowNewFolderButton = $false

    if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
        throw 'No SillyTavern folder was selected.'
    }

    return $dialog.SelectedPath
}

function Test-CoreHooksInstalled {
    param([string]$Root)

    $script = Get-Content (Join-Path $Root 'public\script.js') -Raw
    $context = Get-Content (Join-Path $Root 'public\scripts\st-context.js') -Raw

    return $script.Contains('registerGenerationFinalizer') -and
        $script.Contains('prepareChatCompletionMessages') -and
        $context.Contains('prepareChatCompletionMessages')
}

try {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw 'Git was not found. Install Git for Windows, then run this installer again.'
    }

    if (-not $SillyTavernPath) {
        $SillyTavernPath = Select-SillyTavernRoot
    }

    $SillyTavernPath = (Resolve-Path $SillyTavernPath).Path
    if (-not (Test-SillyTavernRoot $SillyTavernPath)) {
        throw 'The selected folder is not a SillyTavern Git checkout with public\\script.js.'
    }

    if (Test-CoreHooksInstalled $SillyTavernPath) {
        Write-Host 'Multi-Stage Response Composer core hooks are already installed.' -ForegroundColor Green
        exit 0
    }

    & git -C $SillyTavernPath cat-file -e "$expectedBaseCommit^{commit}"
    if ($LASTEXITCODE -ne 0) {
        throw "This SillyTavern checkout does not contain the supported base commit $expectedBaseCommit. Update to a compatible release or use the matching fork before running the installer."
    }

    & git -C $SillyTavernPath merge-base --is-ancestor $expectedBaseCommit HEAD
    if ($LASTEXITCODE -ne 0) {
        throw "This SillyTavern checkout is older than or unrelated to the supported base commit $expectedBaseCommit. No changes were made."
    }

    $patches = @(Get-ChildItem $patchDirectory -Filter '*.patch' -File | Sort-Object Name)
    if ($patches.Count -eq 0) {
        throw 'The bundled core patch series is missing.'
    }

    $status = & git -C $SillyTavernPath status --porcelain
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not read the Git status of the selected checkout.'
    }
    if ($status) {
        throw 'The selected checkout has uncommitted changes. Commit or stash them, then run the installer again.'
    }

    $gitDirectory = (& git -C $SillyTavernPath rev-parse --git-dir).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not locate the Git directory of the selected checkout.'
    }
    if (-not [System.IO.Path]::IsPathRooted($gitDirectory)) {
        $gitDirectory = Join-Path $SillyTavernPath $gitDirectory
    }
    if ((Test-Path (Join-Path $gitDirectory 'rebase-apply')) -or (Test-Path (Join-Path $gitDirectory 'rebase-merge'))) {
        throw 'This checkout already has a rebase or git am operation in progress. Finish or abort it first.'
    }

    Write-Host 'Applying Multi-Stage Response Composer core hooks...' -ForegroundColor Cyan
    $gitArguments = @('-C', $SillyTavernPath, 'am', '--3way') + @($patches.FullName)
    & git @gitArguments
    if ($LASTEXITCODE -ne 0) {
        & git -C $SillyTavernPath am --abort 2>$null
        throw 'The core patches could not be applied. The installer restored the checkout without applying them.'
    }

    if (-not (Test-CoreHooksInstalled $SillyTavernPath)) {
        throw 'Git applied the patches, but the required core hooks were not found afterwards.'
    }

    Write-Host 'Installed successfully. Restart SillyTavern, then refresh the browser with Ctrl+F5.' -ForegroundColor Green
    exit 0
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
