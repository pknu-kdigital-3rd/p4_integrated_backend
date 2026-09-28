param(
    [switch]$SkipCertificateCheck,
    [switch]$SkipTiles,
    [string]$PlanetilerImage = 'ghcr.io/onthegomap/planetiler@sha256:00188a521a1ef986498149c8cb0281822a8b52b885dffc68a4928093796a8487'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$mapDir = Join-Path $repoRoot 'data/map'
New-Item -ItemType Directory -Force -Path $mapDir | Out-Null

function Get-MapAsset([string]$Url, [string]$Destination) {
    if ((Test-Path -LiteralPath $Destination) -and (Get-Item -LiteralPath $Destination).Length -gt 0) { return }
    $parent = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    $partial = "$Destination.partial"
    $options = @{ Uri = $Url; OutFile = $partial }
    if ($SkipCertificateCheck) { $options.SkipCertificateCheck = $true }
    try {
        Invoke-WebRequest @options
        if ((Get-Item -LiteralPath $partial).Length -eq 0) { throw "Empty download: $Url" }
        Move-Item -LiteralPath $partial -Destination $Destination -Force
    } catch {
        Remove-Item -LiteralPath $partial -ErrorAction SilentlyContinue
        throw
    }
}

$fontDir = Join-Path $mapDir 'fonts/Noto Sans Regular'
$fontStarts = @(0, 256, 4352, 12544) + @(44032..55040 | Where-Object { ($_ - 44032) % 256 -eq 0 })
foreach ($start in $fontStarts) {
    $end = $start + 255
    Get-MapAsset "https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/$start-$end.pbf" (Join-Path $fontDir "$start-$end.pbf")
}

$spriteDir = Join-Path $mapDir 'sprites'
foreach ($suffix in @('.json', '.png', '@2x.json', '@2x.png')) {
    Get-MapAsset "https://tiles.openfreemap.org/sprites/ofm_f384/ofm$suffix" (Join-Path $spriteDir "ofm$suffix")
}

if (-not $SkipTiles) {
    Get-MapAsset 'https://download.geofabrik.de/asia/south-korea-latest.osm.pbf' (Join-Path $mapDir 'south-korea.osm.pbf')
    $tileArchive = Join-Path $mapDir 'busan.pmtiles'
    if (-not (Test-Path -LiteralPath $tileArchive) -or (Get-Item -LiteralPath $tileArchive).Length -lt 1MB) {
        $partialArchive = Join-Path $mapDir 'busan.building.pmtiles'
        Remove-Item -LiteralPath $partialArchive -ErrorAction SilentlyContinue
        docker run --rm -e JAVA_TOOL_OPTIONS=-Xmx2g -v "${mapDir}:/data" $PlanetilerImage `
            --download --osm-path=/data/south-korea.osm.pbf `
            --bounds=128.7,34.8,129.5,35.5 --threads=4 --output=/data/busan.building.pmtiles
        if ($LASTEXITCODE -ne 0) { throw "Planetiler failed with exit code $LASTEXITCODE" }
        if ((Get-Item -LiteralPath $partialArchive).Length -lt 1MB) { throw 'The generated PMTiles archive is unexpectedly small.' }
        Move-Item -LiteralPath $partialArchive -Destination $tileArchive -Force
    }
}

Write-Host "Offline map assets ready in $mapDir"
