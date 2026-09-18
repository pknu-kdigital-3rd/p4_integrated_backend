"""Resolve each live video frame to a position on the source recording timeline.

The Android camera films externally displayed footage whose QR codes carry
``source_timestamp_ns``. A frame with a decoded QR anchors the timeline exactly;
frames between QR decodes are extrapolated from the RTP PTS of the last anchor
using a source-time-per-PTS ratio estimated from consecutive anchors, so slow,
fast, and paused external playback are all followed.

This is deliberately independent of ``monocular.QRResolver`` so that resolver's
behavior stays stable; telemetry matching only consumes this module.
"""

from __future__ import annotations

from dataclasses import dataclass

NANOSECONDS_PER_SECOND = 1_000_000_000
PTS_CLOCK_RATE = 90_000
NOMINAL_NS_PER_PTS = NANOSECONDS_PER_SECOND / PTS_CLOCK_RATE

# Stop extrapolating after this much PTS time without a valid QR: the footage
# may have been paused, obscured, or changed, and inventing source time would
# drift telemetry away from what is on screen.
DEFAULT_MAX_EXTRAPOLATION_S = 1.5
# A QR more than this far behind the previous anchor is a rewind/seek.
DEFAULT_BACKWARD_TOLERANCE_S = 0.5
# A QR this far from where the PTS extrapolation predicted is a seek.
DEFAULT_FORWARD_TOLERANCE_S = 2.0
# Measure the playback ratio over at least this much PTS time; adjacent QR
# anchors are only two frames apart and their quantization would dominate.
MIN_RATE_WINDOW_S = 0.5
MAX_PLAYBACK_RATE = 4.0

STATUS_QR = "qr"
STATUS_EXTRAPOLATED = "extrapolated"
STATUS_STALE = "stale"
STATUS_UNAVAILABLE = "unavailable"
STATUS_NO_PTS = "no_pts"


@dataclass(frozen=True)
class SourceTimeResolution:
    source_timestamp_ns: int | None
    status: str
    generation: int


class SourceTimelineResolver:
    def __init__(
        self,
        *,
        max_extrapolation_s: float = DEFAULT_MAX_EXTRAPOLATION_S,
        backward_tolerance_s: float = DEFAULT_BACKWARD_TOLERANCE_S,
        forward_tolerance_s: float = DEFAULT_FORWARD_TOLERANCE_S,
    ) -> None:
        self.max_extrapolation_pts = int(max_extrapolation_s * PTS_CLOCK_RATE)
        self.backward_tolerance_ns = int(backward_tolerance_s * NANOSECONDS_PER_SECOND)
        self.forward_tolerance_ns = int(forward_tolerance_s * NANOSECONDS_PER_SECOND)
        self.generation = 0
        self.resets = 0
        self.reset()
        self.resets = 0

    def reset(self) -> None:
        """Forget all anchors (new relay epoch / decoder restart)."""

        self._anchor_source_ns: int | None = None
        self._anchor_pts: int | None = None
        self._rate_ref_source_ns: int | None = None
        self._rate_ref_pts: int | None = None
        self._ns_per_pts = NOMINAL_NS_PER_PTS
        self.generation += 1
        self.resets += 1

    @property
    def playback_rate(self) -> float:
        return self._ns_per_pts / NOMINAL_NS_PER_PTS

    def _predict(self, pts: int) -> int:
        assert self._anchor_source_ns is not None and self._anchor_pts is not None
        return self._anchor_source_ns + round((pts - self._anchor_pts) * self._ns_per_pts)

    def _discontinuity(self, source_ns: int, pts: int) -> None:
        self.generation += 1
        self.resets += 1
        self._ns_per_pts = NOMINAL_NS_PER_PTS
        self._rate_ref_source_ns = source_ns
        self._rate_ref_pts = pts

    def resolve(
        self,
        pts: int | None,
        qr_source_timestamp_ns: int | None,
        qr_decode_success: bool,
    ) -> SourceTimeResolution:
        if pts is None:
            return SourceTimeResolution(None, STATUS_NO_PTS, self.generation)
        pts = int(pts)
        if qr_decode_success and qr_source_timestamp_ns is not None:
            return self._anchor(int(qr_source_timestamp_ns), pts)
        if self._anchor_source_ns is None or self._anchor_pts is None:
            return SourceTimeResolution(None, STATUS_UNAVAILABLE, self.generation)
        elapsed = pts - self._anchor_pts
        if elapsed < 0 or elapsed > self.max_extrapolation_pts:
            return SourceTimeResolution(None, STATUS_STALE, self.generation)
        return SourceTimeResolution(self._predict(pts), STATUS_EXTRAPOLATED, self.generation)

    def _anchor(self, source_ns: int, pts: int) -> SourceTimeResolution:
        if self._anchor_source_ns is None or self._anchor_pts is None:
            self._rate_ref_source_ns, self._rate_ref_pts = source_ns, pts
        elif pts < self._anchor_pts or source_ns < self._anchor_source_ns - self.backward_tolerance_ns:
            self._discontinuity(source_ns, pts)
        elif (
            pts - self._anchor_pts <= self.max_extrapolation_pts
            and abs(source_ns - self._predict(pts)) > self.forward_tolerance_ns
        ) or (
            pts - self._anchor_pts > self.max_extrapolation_pts
            and source_ns - self._anchor_source_ns
            > (pts - self._anchor_pts) * NOMINAL_NS_PER_PTS * MAX_PLAYBACK_RATE + self.forward_tolerance_ns
        ):
            # A jump far beyond what the elapsed PTS could explain is a seek:
            # never interpolate or match across it.
            self._discontinuity(source_ns, pts)
        else:
            self._update_rate(source_ns, pts)
        self._anchor_source_ns, self._anchor_pts = source_ns, pts
        return SourceTimeResolution(source_ns, STATUS_QR, self.generation)

    def _update_rate(self, source_ns: int, pts: int) -> None:
        if self._rate_ref_pts is None or self._rate_ref_source_ns is None:
            self._rate_ref_source_ns, self._rate_ref_pts = source_ns, pts
            return
        pts_delta = pts - self._rate_ref_pts
        if pts_delta < MIN_RATE_WINDOW_S * PTS_CLOCK_RATE:
            return
        ratio = (source_ns - self._rate_ref_source_ns) / pts_delta
        self._ns_per_pts = min(max(ratio, 0.0), NOMINAL_NS_PER_PTS * MAX_PLAYBACK_RATE)
        self._rate_ref_source_ns, self._rate_ref_pts = source_ns, pts
