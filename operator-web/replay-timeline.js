export function segmentDuration(video) {
  try {
    if (video.durationPts90k && BigInt(video.durationPts90k) > 0n) {
      return Number(BigInt(video.durationPts90k)) / 90000;
    }
  } catch {}
  return Math.max(0, Number(video.durationSec) || 0);
}

function segmentsContinuous(previous, next) {
  try {
    return previous.recordingSessionId === next.recordingSessionId
      && previous.relayEpoch === next.relayEpoch
      && BigInt(next.startSeq) === BigInt(previous.endSeq) + 1n
      && previous.durationPts90k != null
      && BigInt(previous.startPts90k) + BigInt(previous.durationPts90k) === BigInt(next.startPts90k);
  } catch {
    return false;
  }
}

export function buildReplayTimeline(videos) {
  const entries = [];
  let duration = 0;
  for (const video of videos) {
    const segmentSeconds = segmentDuration(video);
    if (segmentSeconds <= 0) continue;
    const previous = entries.at(-1);
    const entry = {
      video,
      duration: segmentSeconds,
      start: duration,
      end: duration + segmentSeconds,
      breakBefore: Boolean(previous && !segmentsContinuous(previous.video, video)),
      wallGapSeconds: previous && video.startedAt && previous.video.endedAt
        ? (new Date(video.startedAt) - new Date(previous.video.endedAt)) / 1000
        : 0,
      unavailable: false,
      samples: [],
      samplesLoaded: false,
      sampleLoadPromise: null,
      coverageIncomplete: true,
    };
    entries.push(entry);
    duration = entry.end;
  }
  return { entries, duration };
}

export function entryForTime(entries, totalDuration, value, direction = 1) {
  if (!entries.length) return -1;
  const position = Math.max(0, Math.min(totalDuration, Number(value) || 0));
  let index = entries.findIndex((entry, current) => (
    position >= entry.start
    && (position < entry.end || (current === entries.length - 1 && position <= entry.end))
  ));
  if (index < 0) index = direction < 0 ? entries.length - 1 : 0;
  return index;
}

export function detectionSampleAtPts(samples, videoPts90k, maxAge90k = 90_000n) {
  const target = BigInt(videoPts90k);
  let latest = null;
  for (const sample of samples) {
    const pts = BigInt(sample.videoPts90k);
    if (pts > target) break;
    latest = sample;
  }
  if (!latest || target - BigInt(latest.videoPts90k) > maxAge90k) return null;
  return latest;
}
