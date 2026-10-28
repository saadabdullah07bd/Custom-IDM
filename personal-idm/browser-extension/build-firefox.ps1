# Builds the Firefox add-on (.xpi) for Personal IDM
# Run: powershell -ExecutionPolicy Bypass -File build-firefox.ps1

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestPath = Join-Path $here "manifest-firefox.json"
$ver = (Get-Content $manifestPath -Raw | ConvertFrom-Json).version
$outXpi = Join-Path (Split-Path -Parent $here) "Personal-IDM-Firefox-$ver.xpi"

$stage = Join-Path $env:TEMP "personal-idm-firefox-stage"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

# Copy shared extension files
foreach ($f in "background.js", "content.js", "content.css") {
  Copy-Item (Join-Path $here $f) $stage
}

# Rename manifest-firefox.json to manifest.json in staged package
Copy-Item $manifestPath (Join-Path $stage "manifest.json")

if (Test-Path $outXpi) { Remove-Item $outXpi -Force }

$zipPath = [System.IO.Path]::ChangeExtension($outXpi, ".zip")
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zipPath -CompressionLevel Optimal
Move-Item $zipPath $outXpi -Force

Write-Host ("Successfully built Firefox Add-on: {0} ({1} bytes)" -f $outXpi, (Get-Item $outXpi).Length)
