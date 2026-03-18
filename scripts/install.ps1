# fixbot Installer for Windows
# Usage: irm https://raw.githubusercontent.com/ukint-vs/fixbot/main/scripts/install.ps1 | iex
#
# Or with options:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/ukint-vs/fixbot/main/scripts/install.ps1))) -Source
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/ukint-vs/fixbot/main/scripts/install.ps1))) -Binary
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/ukint-vs/fixbot/main/scripts/install.ps1))) -Source -Ref v3.20.1
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/ukint-vs/fixbot/main/scripts/install.ps1))) -Source -Ref main
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/ukint-vs/fixbot/main/scripts/install.ps1))) -Binary -Ref v3.20.1

param(
    [switch]$Source,
    [switch]$Binary,
    [string]$Ref
)

$ErrorActionPreference = "Stop"

$Repo = "ukint-vs/fixbot"
$InstallDir = if ($env:PI_INSTALL_DIR) { $env:PI_INSTALL_DIR } else { "$env:LOCALAPPDATA\fixbot" }
$BinaryName = "fixbot-windows-x64.exe"
$NativeAddonNames = @("pi_natives.win32-x64-modern.node", "pi_natives.win32-x64-baseline.node")
$MinimumBunVersion = "1.3.7"

function Test-BunInstalled {
    try {
        $null = Get-Command bun -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Get-BunVersion {
    try {
        $versionText = (bun --version 2>$null)
        if (-not $versionText) {
            return $null
        }

        $clean = $versionText.Trim().Split("-")[0]
        return [version]$clean
    } catch {
        return $null
    }
}

function Test-BunVersion {
    param([string]$MinimumVersion)

    $currentVersion = Get-BunVersion
    if (-not $currentVersion) {
        return $false
    }

    return $currentVersion -ge [version]$MinimumVersion
}

function Assert-BunVersion {
    param([string]$MinimumVersion)

    if (-not (Test-BunVersion $MinimumVersion)) {
        $current = Get-BunVersion
        $currentText = if ($current) { $current.ToString() } else { "unknown" }
        throw "Bun $MinimumVersion or newer is required. Current version: $currentText. Upgrade Bun at https://bun.sh/docs/installation"
    }
}

function Test-GitInstalled {
    try {
        $null = Get-Command git -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Test-GitLfsInstalled {
    try {
        $null = Get-Command git-lfs -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Find-BashShell {
    # Check Git Bash first (most common on Windows)
    $gitBash = "C:\Program Files\Git\bin\bash.exe"
    if (Test-Path $gitBash) {
        return $gitBash
    }

    # Check bash.exe on PATH (Cygwin, MSYS2, WSL)
    try {
        $bashCmd = Get-Command bash.exe -ErrorAction Stop
        return $bashCmd.Source
    } catch {
        return $null
    }
}

function Configure-BashShell {
    try {
        $settingsDir = Join-Path $env:USERPROFILE ".fixbot\agent"
        $settingsFile = Join-Path $settingsDir "settings.json"

        # Check if settings.json already has a shellPath configured
        if (Test-Path $settingsFile) {
            try {
                $existingSettings = Get-Content $settingsFile -Raw | ConvertFrom-Json
                if ($existingSettings.shellPath) {
                    Write-Host "Bash shell already configured: $($existingSettings.shellPath)" -ForegroundColor Cyan
                    return
                }
            } catch {
                # Invalid JSON, we'll overwrite it
            }
        }

        $bashPath = Find-BashShell

        if ($bashPath) {
            Write-Host "Found bash shell: $bashPath" -ForegroundColor Cyan

            # Create settings directory if needed
            if (-not (Test-Path $settingsDir)) {
                New-Item -ItemType Directory -Force -Path $settingsDir | Out-Null
            }

            # Read existing settings or create new
            $settings = @{}
            if (Test-Path $settingsFile) {
                try {
                    $settings = Get-Content $settingsFile -Raw | ConvertFrom-Json -AsHashtable
                } catch {
                    $settings = @{}
                }
            }

            # Set shellPath
            $settings["shellPath"] = $bashPath

            # Write settings
            $settings | ConvertTo-Json -Depth 10 | Set-Content $settingsFile -Encoding UTF8
            Write-Host "✓ Configured shell path in $settingsFile" -ForegroundColor Green
        } else {
            Write-Host ""
            Write-Host "⚠ No bash shell found!" -ForegroundColor Yellow
            Write-Host "  fixbot requires a bash shell on Windows. Options:" -ForegroundColor Yellow
            Write-Host "    1. Install Git for Windows: https://git-scm.com/download/win" -ForegroundColor Yellow
            Write-Host "    2. Use WSL, Cygwin, or MSYS2" -ForegroundColor Yellow
            Write-Host ""
            Write-Host "  After installing, you can set a custom path in:" -ForegroundColor Yellow
            Write-Host "    $settingsFile" -ForegroundColor Yellow
            Write-Host '    { "shellPath": "C:\\path\\to\\bash.exe" }' -ForegroundColor Yellow
        }
    } catch {
        Write-Host "⚠ Could not configure bash shell: $_" -ForegroundColor Yellow
    }
}

function Install-Bun {
    Write-Host "Installing bun..."
    irm bun.sh/install.ps1 | iex
    # Refresh PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "User") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    Assert-BunVersion $MinimumBunVersion
}

function Install-ViaBun {
    # Install from source — workspace:* deps require the full monorepo context.
    # Clones to ~/.fixbot/source and creates a wrapper script in InstallDir.
    Write-Host "Installing fixbot from source..."
    if (-not (Test-GitInstalled)) {
        throw "git is required for source install"
    }

    $sourceDir = Join-Path $env:USERPROFILE ".fixbot\source"
    $cloneRef = if ($Ref) { $Ref } else { "main" }

    # Clean previous source install
    if (Test-Path $sourceDir) {
        Write-Host "Removing previous source install..."
        Remove-Item -Recurse -Force $sourceDir
    }

    $repoUrl = "https://github.com/$Repo.git"
    $cloneOk = $false
    try {
        git clone --depth 1 --branch $cloneRef $repoUrl $sourceDir | Out-Null
        $cloneOk = $true
    } catch {
        $cloneOk = $false
    }

    if (-not $cloneOk) {
        git clone $repoUrl $sourceDir | Out-Null
        Push-Location $sourceDir
        try {
            git checkout $cloneRef | Out-Null
        } finally {
            Pop-Location
        }
    }

    # Pull LFS files
    if (Test-GitLfsInstalled) {
        Push-Location $sourceDir
        try {
            git lfs pull | Out-Null
        } finally {
            Pop-Location
        }
    }

    $packagePath = Join-Path $sourceDir "packages\coding-agent"
    if (-not (Test-Path $packagePath)) {
        throw "Expected package at $packagePath"
    }

    # Install monorepo dependencies
    Write-Host "Installing dependencies..."
    Push-Location $sourceDir
    try {
        bun install
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to install dependencies"
        }
    } finally {
        Pop-Location
    }

    # Build native addons (requires Rust toolchain)
    try {
        $null = Get-Command cargo -ErrorAction Stop
        Write-Host "Building native addons..."
        Push-Location $sourceDir
        try {
            bun run build:native
            if ($LASTEXITCODE -ne 0) {
                Write-Host "⚠ Native addon build failed. fixbot will work but some features may be slower." -ForegroundColor Yellow
                Write-Host "  To retry later: cd $sourceDir && bun run build:native" -ForegroundColor Yellow
            }
        } finally {
            Pop-Location
        }
    } catch {
        Write-Host "⚠ Rust toolchain not found — skipping native addon build." -ForegroundColor Yellow
        Write-Host "  fixbot will work but some features (search, media) may be slower." -ForegroundColor Yellow
        Write-Host "  Install Rust (https://rustup.rs) then run: cd $sourceDir; bun run build:native" -ForegroundColor Yellow
    }

    # Create wrapper script
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $cliPath = Join-Path $sourceDir "packages\coding-agent\src\cli.ts"
    $wrapperPath = Join-Path $InstallDir "fixbot.cmd"
    Set-Content -Path $wrapperPath -Value "@bun run `"$cliPath`" %*" -Encoding ASCII

    Write-Host ""
    Write-Host "✓ Installed fixbot via bun" -ForegroundColor Green
    Write-Host "  Source: $sourceDir" -ForegroundColor Cyan
    Write-Host "  Binary: $wrapperPath" -ForegroundColor Cyan

    Configure-BashShell

    # Add to PATH if not already there
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($UserPath -notlike "*$InstallDir*") {
        Write-Host "Adding $InstallDir to PATH..."
        [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
        Write-Host "Restart your terminal, then run 'fixbot' to get started!"
    } else {
        Write-Host "Run 'fixbot' to get started!"
    }
}

function Install-Binary {
    if ($Ref) {
        Write-Host "Fetching release $Ref..."
        try {
            $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$Ref"
        } catch {
            throw "Release tag not found: $Ref`nFor branch/commit installs, use -Source with -Ref."
        }
    } else {
        Write-Host "Fetching latest release..."
        $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
    }

    $Latest = $Release.tag_name
    if (-not $Latest) {
        throw "Failed to fetch release tag"
    }
    Write-Host "Using version: $Latest"

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

    # Download binary
    $BinaryUrl = "https://github.com/$Repo/releases/download/$Latest/$BinaryName"
    Write-Host "Downloading $BinaryName..."
    $OutPath = Join-Path $InstallDir "fixbot.exe"
    Invoke-WebRequest -Uri $BinaryUrl -OutFile $OutPath

    # Download native addons
    $downloadedNative = 0
    foreach ($nativeAddonName in $NativeAddonNames) {
        $nativeUrl = "https://github.com/$Repo/releases/download/$Latest/$nativeAddonName"
        Write-Host "Downloading $nativeAddonName..."
        $nativeOutPath = Join-Path $InstallDir $nativeAddonName
        Invoke-WebRequest -Uri $nativeUrl -OutFile $nativeOutPath
        $downloadedNative += 1
    }
    Write-Host ""
    Write-Host "✓ Installed fixbot to $OutPath" -ForegroundColor Green
    Write-Host "✓ Installed $downloadedNative native addon file(s) to $InstallDir" -ForegroundColor Green

    # Add to PATH if not already there
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $needsRestart = $UserPath -notlike "*$InstallDir*"
    if ($needsRestart) {
        Write-Host "Adding $InstallDir to PATH..."
        [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
    }

    Configure-BashShell

    if ($needsRestart) {
        Write-Host "Restart your terminal, then run 'fixbot' to get started!"
    } else {
        Write-Host "Run 'fixbot' to get started!"
    }
}

# Main logic
if ($Ref -and -not $Source -and -not $Binary) {
    $Source = $true
}

if ($Source) {
    if (-not (Test-BunInstalled)) {
        Install-Bun
    }
    Assert-BunVersion $MinimumBunVersion
    Install-ViaBun
} elseif ($Binary) {
    Install-Binary
} else {
    # Default: use bun if available, otherwise binary
    if (Test-BunInstalled) {
        Assert-BunVersion $MinimumBunVersion
        Install-ViaBun
    } else {
        Install-Binary
    }
}
