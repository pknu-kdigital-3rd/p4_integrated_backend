# Trip-Wide Replay and Detection Overlay Plan

## Goal

Let an operator play one trip as a continuous, seekable timeline across its finalized MinIO video segments, and show saved detections at the matching video time. This first version covers recordings created after deployment and shows bounding boxes, class labels, and confidence. It does not add risk classification or event markers.

## Playback behavior

- Build a virtual playlist from the trip's ordered video segments. Keep the existing MP4 objects separate; request each presigned playback URL only when that segment is needed.
- Provide trip-wide play/pause, seek, elapsed/total time, and automatic segment advance. Seeking resolves the global playable-time offset to a segment and then to that segment's local time.
- Skip unrecorded time in the seek duration while displaying a break marker and the observed gap duration between discontinuous segments.
- Store exact segment duration in 90 kHz ticks. Retain the existing rounded `durationSec` for compatibility and use it only as a fallback for older segments.
- Show an unavailable segment as a marked gap with a retry/skip path; do not stop playback of later segments.

## Detection persistence and synchronization

- Propagate the relay's validated trip, vehicle, and recording-session identity to Vision frame metadata. Each frame already carries relay epoch, sequence, and 90 kHz PTS; preserve these values as the synchronization key.
- Add a replay detection-sample table. By default, store every completed inference result, including empty detection lists, with normalized boxes, class labels, confidence, optional track IDs, frame sequence, epoch, and PTS. `RECORDING_DETECTION_SAMPLE_EVERY_N_FRAMES` stores one result every N completed inference results. Key writes idempotently by trip, session, epoch, and frame sequence.
- Use Prisma schema/migrations as the database schema source of truth. Vision posts batches through a bounded background writer to Node's internal endpoint; Node persists and reads them with Prisma Client. Do not use raw queries in Node.
- Keep writes out of the inference critical path with a bounded queue. If the database is unavailable or the queue overflows, live inference continues; missing inference samples make replay coverage visibly incomplete.
- Do not rerun inference during replay or backfill existing videos. Defer risk rules and event markers until an authoritative event source and risk policy exist.

## API and operator UI

- Extend trip-video metadata with precise duration ticks while keeping the current segment listing and on-demand playback URL behavior.
- Add an authenticated per-segment detections endpoint scoped to the trip and segment. Return ordered samples with PTS, normalized boxes, and coverage status.
- Replace the per-segment-only player flow with a trip timeline and a canvas overlay synchronized from segment-local media time. Clear boxes on empty samples and display an incomplete-coverage indicator when samples are missing.
- Keep video bytes on direct presigned MinIO URLs; Node serves only metadata and detection samples.

## Verification

- Test segment duration and offset calculations, auto-advance, global seek in both directions, discontinuity markers, unavailable-segment recovery, and boundary behavior.
- Test Vision sampling cadence, normalized output, idempotent batches, bounded-queue behavior, and continued inference during database outages.
- Test Node authentication, trip/segment ownership checks, sample ordering and PTS bounds, and coverage status using Prisma Client.
- Run a multi-segment replay fixture to verify boxes align with PTS and seeking. Measure inference latency, dropped frames, queue depth, and memory with persistence enabled. No Android changes or Android tests are in scope.

## Assumptions

- The existing publisher already supplies trip, vehicle, and recording-session identity; changes are limited to relay-to-Vision metadata propagation.
- At segment discontinuities the UI concatenates playable media time and marks gaps instead of inserting blank seek time.
- Existing database event rows are not treated as a source of new replay overlays. V1 persists detections only and makes no new safety/risk decisions.
