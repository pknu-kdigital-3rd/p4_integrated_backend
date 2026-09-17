const maximumExpectedSampleGap90k = 67_500n;

export function detectionCoverageIncomplete(
    startPts90k: bigint,
    endPts90k: bigint,
    samples: bigint[],
): boolean {
    if (samples.length === 0) return true;
    let previousPts = startPts90k;
    for (const pts of samples) {
        if (pts - previousPts > maximumExpectedSampleGap90k) return true;
        previousPts = pts;
    }
    return endPts90k - previousPts > maximumExpectedSampleGap90k;
}
