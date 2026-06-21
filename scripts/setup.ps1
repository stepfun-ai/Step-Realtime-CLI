param(
  [switch]$SkipInstall,
  [switch]$SkipBuild,
  [switch]$SkipBun,
  [switch]$ForceConfig,
  [switch]$Uninstall,
  [switch]$Overseas,
  [string]$StepChromePath
)

$ErrorActionPreference = "Stop"

function Write-Section([string]$Text) {
  Write-Host ""
  Write-Host $Text -ForegroundColor White
}

function Write-Info([string]$Text) {
  Write-Host "  $Text"
}

function Write-Ok([string]$Text) {
  Write-Host "  OK $Text" -ForegroundColor Green
}

function Write-Warn([string]$Text) {
  Write-Host "  ! $Text" -ForegroundColor Yellow
}

function Write-Err([string]$Text) {
  Write-Host "  X $Text" -ForegroundColor Red
}

function Test-Command([string]$Name) {
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Invoke-StepCli {
  node scripts/run-step.mjs --stale-only @args
  if ($LASTEXITCODE -ne 0) {
    throw "step CLI command failed with exit code $LASTEXITCODE"
  }
}

function Add-UserPath([string]$PathToAdd) {
  $current = [Environment]::GetEnvironmentVariable("Path", "User")
  $parts = @()
  if ($current) {
    $parts = $current -split ";" | Where-Object { $_ -ne "" }
  }
  if ($parts -contains $PathToAdd) {
    Write-Ok "$PathToAdd is already on the user PATH"
    return
  }
  $next = (@($parts) + $PathToAdd) -join ";"
  [Environment]::SetEnvironmentVariable("Path", $next, "User")
  Write-Ok "Added $PathToAdd to the user PATH"
  Write-Info "Open a new PowerShell window before running step from PATH."
}

function Remove-UserPath([string]$PathToRemove) {
  $current = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not $current) { return }
  $parts = $current -split ";" | Where-Object { $_ -and ($_ -ne $PathToRemove) }
  [Environment]::SetEnvironmentVariable("Path", ($parts -join ";"), "User")
}

function Ensure-ObjectProperty([object]$Object, [string]$Name) {
  $property = $Object.PSObject.Properties[$Name]
  if (($null -eq $property) -or ($null -eq $property.Value)) {
    if ($null -eq $property) {
      $Object | Add-Member -NotePropertyName $Name -NotePropertyValue ([pscustomobject]@{})
    } else {
      $property.Value = [pscustomobject]@{}
    }
  }
  return $Object.PSObject.Properties[$Name].Value
}

function Find-Chrome {
  if ($StepChromePath -and (Test-Path $StepChromePath)) {
    $env:STEP_CHROME_PATH = $StepChromePath
    return $StepChromePath
  }
  if ($env:STEP_CHROME_PATH -and (Test-Path $env:STEP_CHROME_PATH)) {
    return $env:STEP_CHROME_PATH
  }
  if ($env:CHROME_PATH -and (Test-Path $env:CHROME_PATH)) {
    return $env:CHROME_PATH
  }

  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return $candidate
    }
  }
  return $null
}

function Resolve-BunBin {
  if ($env:STEP_BUN_BIN -and (Test-Path $env:STEP_BUN_BIN)) {
    return $env:STEP_BUN_BIN
  }
  $cmd = Get-Command bun -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }
  return $null
}

function Install-Bun {
  <#
    .SYNOPSIS
      Ensures Bun is available on PATH. Strategy:
        1. Already on PATH -> use it
        2. winget -> install Oven-sh.Bun
        3. Direct download -> github.com/oven-sh/bun/releases/latest
      Returns the path to bun.exe, or $null if all attempts failed.
  #>
  $existing = Resolve-BunBin
  if ($existing) {
    Write-Ok "Bun already available: $existing"
    return $existing
  }

  Write-Section "[bun] Installing Bun (needed for OpenTUI TUI on Windows)"

  if (Test-Command "winget") {
    Write-Info "Trying winget install Oven-sh.Bun ..."
    & winget install Oven-sh.Bun --accept-source-agreements --accept-package-agreements --silent
    if ($LASTEXITCODE -eq 0) {
      $bunPath = Join-Path $HOME ".bun\bin\bun.exe"
      if ($env:Path -notlike "*$HOME\.bun\bin*") {
        $env:Path = "$HOME\.bun\bin;$env:Path"
      }
      $cmd = Get-Command bun -ErrorAction SilentlyContinue
      $candidate = if ($cmd) { $cmd.Source } elseif (Test-Path $bunPath) { $bunPath } else { $null }
      if ($candidate) {
        $versionOutput = & $candidate --version 2>$null
        if ($LASTEXITCODE -eq 0 -and $versionOutput) {
          Write-Ok "Bun installed via winget: $candidate ($($versionOutput.Trim()))"
          return $candidate
        }
        Write-Warn "Bun at $candidate did not respond to --version; continuing to next strategy"
      }
    }
    Write-Warn "winget install exited $LASTEXITCODE; falling back to direct download"
  }

  $installDir = Join-Path $HOME ".bun"
  $bunExe = Join-Path $installDir "bin\bun.exe"
  if (Test-Path $bunExe) {
    Write-Ok "Bun already downloaded at $bunExe"
    return $bunExe
  }

  Write-Info "Downloading Bun for Windows x64 from github.com/oven-sh/bun ..."
  $zipUrl = "https://github.com/oven-sh/bun/releases/latest/download/bun-windows-x64.zip"
  $tmpZip = Join-Path $env:TEMP "bun-windows-x64.zip"
  try {
    Invoke-WebRequest -Uri $zipUrl -OutFile $tmpZip -UseBasicParsing
    Expand-Archive -Path $tmpZip -DestinationPath $installDir -Force
    # The zip extracts as `bun-windows-x64\bun.exe`; flatten into bin\
    $nested = Join-Path $installDir "bun-windows-x64\bun.exe"
    if (Test-Path $nested) {
      New-Item -ItemType Directory -Force (Join-Path $installDir "bin") | Out-Null
      Move-Item -Force $nested $bunExe
      Remove-Item -Recurse -Force (Join-Path $installDir "bun-windows-x64") -ErrorAction SilentlyContinue
    }
    if (Test-Path $bunExe) {
      $versionOutput = & $bunExe --version 2>$null
      if ($LASTEXITCODE -eq 0 -and $versionOutput) {
        Add-UserPath (Join-Path $installDir "bin")
        Write-Ok "Bun installed via direct download: $bunExe ($($versionOutput.Trim()))"
        return $bunExe
      }
      Write-Warn "Downloaded Bun at $bunExe did not respond to --version; install incomplete"
    }
  } catch {
    Write-Warn "Direct download failed: $($_.Exception.Message)"
  } finally {
    Remove-Item -Force $tmpZip -ErrorAction SilentlyContinue
  }

  Write-Err "Could not install Bun. OpenTUI TUI will not work."
  Write-Info "Manual install: download from https://bun.com/docs/installation/windows"
  Write-Info "Or re-run this script with -SkipBun to install with Node only (text CLI fallback)."
  return $null
}

Set-Location (Join-Path $PSScriptRoot "..")
$RepoRoot = (Get-Location).Path
$InstallDir = Join-Path $HOME ".step-cli\bin"
$UserConfig = Join-Path $HOME ".step-cli\config.json"

if ($Uninstall) {
  Write-Section "[uninstall] Removing Windows install"
  Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue
  Remove-UserPath $InstallDir
  Write-Ok "Removed $InstallDir and its user PATH entry"
  Write-Info "Config and session history under $HOME\.step-cli are preserved."
  Write-Info "Bun installation (under $HOME\.bun) is preserved; uninstall via winget or by deleting the directory."
  exit 0
}

if (-not (Test-Command "pnpm")) {
  Write-Section "[0/8] Bootstrapping pnpm via corepack"
  if (-not (Test-Command "corepack")) {
    Write-Err "Neither pnpm nor corepack was found in PATH."
    Write-Info "Install Node.js 20+ and then re-run this script."
    exit 1
  }
  corepack enable
  corepack prepare pnpm@latest --activate
  if (-not (Test-Command "pnpm")) {
    Write-Err "corepack ran but pnpm is still not on PATH."
    Write-Info "Open a new PowerShell window and re-run this script."
    exit 1
  }
  Write-Ok "pnpm $(pnpm --version) ready"
}

Write-Section "[1/8] Installing workspace dependencies"
if ($SkipInstall) {
  Write-Info "Skipped (-SkipInstall)"
} else {
  pnpm install
  Write-Ok "Workspace dependencies installed"
}

$BunBin = $null
if ($SkipBun) {
  Write-Section "[2/8] Bun (skipped via -SkipBun)"
  Write-Warn "OpenTUI TUI will be unavailable; step will fall back to text CLI."
} else {
  Write-Section "[2/8] Bun runtime (for OpenTUI TUI)"
  $BunBin = Install-Bun
  if ($BunBin) {
    $env:STEP_BUN_BIN = $BunBin
    Write-Ok "STEP_BUN_BIN set to $BunBin"
  } else {
    Write-Warn "Proceeding without Bun. OpenTUI TUI will use Node fallback."
  }
}

Write-Section "[3/8] Initializing user config"
if ((Test-Path $UserConfig) -and (-not $ForceConfig)) {
  Write-Ok "Config already exists at $UserConfig (use -ForceConfig to overwrite)"
} else {
  if ($ForceConfig) {
    Invoke-StepCli config init --scope user --force
  } else {
    Invoke-StepCli config init --scope user
  }
  Write-Ok "Config written to $UserConfig"
}

Write-Section "[4/8] Silero VAD"
pnpm setup:silero
if ($LASTEXITCODE -ne 0) {
  throw "setup:silero failed with exit code $LASTEXITCODE"
}
Invoke-StepCli vad set silero
Invoke-StepCli vad status
Write-Ok "Silero enabled (voice.defaults.vad = silero)"

Write-Section "[5/8] Browser audio / AEC"
$Chrome = Find-Chrome
if ($Chrome) {
  Write-Ok "Chrome/Chromium found: $Chrome"
} else {
  Write-Err "Chrome/Chromium was not found."
  Write-Info "Windows voice mode requires Chrome, Edge, or Chromium for BrowserAudioDriver."
  Write-Info "Install Chrome from https://www.google.com/chrome/ or set STEP_CHROME_PATH."
  exit 1
}

Invoke-StepCli aec on
Invoke-StepCli aec status
Write-Ok "Browser audio enabled (voice.defaults.aec = true)"

if ($Overseas) {
  Write-Section "[overseas] Switching endpoints to api.stepfun.ai"
  if (-not (Test-Path $UserConfig)) {
    Write-Err "Expected $UserConfig to exist after config init."
    exit 1
  }
  $config = Get-Content $UserConfig -Raw | ConvertFrom-Json
  $integrations = Ensure-ObjectProperty $config "integrations"
  $modelsProxy = Ensure-ObjectProperty $integrations "modelsProxy"
  $modelsProxy | Add-Member -Force -NotePropertyName baseUrl -NotePropertyValue "https://api.stepfun.ai/v1"
  $voice = Ensure-ObjectProperty $config "voice"
  $realtime = Ensure-ObjectProperty $voice "realtime"
  $realtime | Add-Member -Force -NotePropertyName endpoint -NotePropertyValue "wss://api.stepfun.ai/v1/realtime/stateless"
  $config | ConvertTo-Json -Depth 20 | Set-Content -Encoding UTF8 $UserConfig
  Write-Ok "Patched $UserConfig for api.stepfun.ai"
}

Write-Section "[6/8] Building production bundle"
  if ($SkipBuild) {
    Write-Warn "Skipped (-SkipBuild). Will reuse existing dist."
  } else {
    pnpm build
    Write-Ok "dist built"
  }

Write-Section "[7/8] Preparing Windows launcher"
if ($SkipBuild) {
  if (-not (Test-Path "dist\index.js")) {
    Write-Err "No existing dist\index.js found; cannot continue with -SkipBuild."
    exit 1
  }
  Write-Warn "Skipped (-SkipBuild). Reusing existing dist."
} else {
  Write-Info "Using a Node-based step.cmd launcher; Bun native compilation is not required on Windows."
}

Write-Section "[8/8] Installing to $InstallDir"
New-Item -ItemType Directory -Force $InstallDir | Out-Null

foreach ($dir in @("package.json", "bin", "dist", "packages", "extensions", "skills", "node_modules")) {
  if (-not (Test-Path $dir)) {
    Write-Warn "Skipping missing source dir: $dir"
    continue
  }
  $target = Join-Path $InstallDir $dir
  Remove-Item -Recurse -Force $target -ErrorAction SilentlyContinue
  Copy-Item -Recurse -Force $dir $target
}
Write-Ok "Runtime tree copied"

$Launcher = Join-Path $InstallDir "step.cmd"
$LauncherContent = @"
@echo off
setlocal
if defined STEP_BUN_BIN (
  "%STEP_BUN_BIN%" "%~dp0bin\step-cli.js" %*
  exit /b %ERRORLEVEL%
)
where bun >nul 2>&1 && (
  bun "%~dp0bin\step-cli.js" %*
  exit /b %ERRORLEVEL%
)
node "%~dp0bin\step-cli.js" %*
exit /b %ERRORLEVEL%
"@
Set-Content -Encoding ASCII -Path $Launcher -Value $LauncherContent
Write-Ok "Installed launcher: $Launcher"

$Smoke = & $Launcher --version 2>&1
if ($LASTEXITCODE -eq 0) {
  Write-Ok "Smoke test passed: $Smoke"
} else {
  Write-Err "Smoke test failed: step.cmd --version exited with $LASTEXITCODE"
  Write-Err "$Smoke"
  exit 1
}

Add-UserPath $InstallDir

Write-Section "Done. Next steps:"
Write-Info "1. Open $UserConfig and replace model.apiKey and voice.realtime.apiKey."
if ($Overseas) {
  Write-Info "   Use API keys from https://platform.stepfun.ai/."
} else {
  Write-Info "   Use API keys from https://platform.stepfun.com/."
}
Write-Info "2. Open a new PowerShell window, then run: step voice"
Write-Info "3. To uninstall: powershell -ExecutionPolicy Bypass -File scripts/setup.ps1 -Uninstall"
