# Launch a QR/GPS replay video, hold its final frame, and press Home to replay.
# mpv options: https://mpv.io/manual/stable/
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$VideoPath,

    [string]$MpvPath = 'mpv',

    [switch]$Fullscreen
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $VideoPath -PathType Leaf)) {
    throw "Video file not found: $VideoPath"
}
$replayVideo = (Resolve-Path -LiteralPath $VideoPath).ProviderPath

try {
    $mpvExecutable = Get-Command -Name $MpvPath -CommandType Application -ErrorAction Stop
} catch {
    throw 'mpv was not found. Supply -MpvPath with the full path to mpv.exe.'
}

$replayBindings = Join-Path $PSScriptRoot 'gps-replay-input.conf'
if (-not (Test-Path -LiteralPath $replayBindings -PathType Leaf)) {
    throw "Replay key bindings not found: $replayBindings"
}

$replayArguments = @(
    '--loop-file=no'
    '--loop-playlist=no'
    '--keep-open=always'
    '--keep-open-pause=yes'
    "--input-conf=$replayBindings"
)
if ($Fullscreen) {
    $replayArguments += '--fullscreen=yes'
}

Write-Host 'At the end, the final frame stays visible. Press Home to replay; Space to pause/resume; Q to quit.'
& $mpvExecutable.Source @replayArguments -- $replayVideo
if ($LASTEXITCODE -ne 0) {
    throw "mpv exited with code $LASTEXITCODE."
}
