"""Host call timelines on one monotonic clock; no additional CUDA waits."""


def model_timeline(origin, yolo_start, yolo_end, depth_times, submitted, parallel, depth_ok):
    timeline = {
        "mode": "yolo_only" if submitted is None else ("parallel" if parallel else "serial"),
        "yolo_start_ms": (yolo_start - origin) * 1000,
        "yolo_end_ms": (yolo_end - origin) * 1000,
    }
    if submitted is None:
        return timeline
    if not depth_ok:
        timeline["mode"] = "depth_error"
    if "end" not in depth_times:
        return timeline
    depth_start, depth_end = depth_times["start"], depth_times["end"]
    timeline.update(
        depth_start_ms=(depth_start - origin) * 1000,
        depth_end_ms=(depth_end - origin) * 1000,
        depth_launch_delay_ms=max(0.0, depth_start - submitted) * 1000,
        overlap_ms=max(0.0, min(yolo_end, depth_end) - max(yolo_start, depth_start)) * 1000,
        yolo_tail_ms=max(0.0, yolo_end - depth_end) * 1000,
        depth_tail_ms=max(0.0, depth_end - yolo_end) * 1000,
        last_model="yolo" if yolo_end > depth_end else ("depth" if depth_end > yolo_end else "tie"),
    )
    return timeline


class ModelTimelineMetrics:
    """Keep interval totals and one slow frame, not an unbounded frame history."""

    FIELDS = ("overlap_ms", "yolo_tail_ms", "depth_tail_ms", "depth_launch_delay_ms")

    def __init__(self):
        self.modes = {}
        self.last = {}
        self.totals = dict.fromkeys(self.FIELDS, 0.0)
        self.slowest = None

    def record(self, result):
        timeline = result.get("model_timeline")
        if not timeline:
            return
        mode = timeline["mode"]
        self.modes[mode] = self.modes.get(mode, 0) + 1
        if mode == "parallel" and "last_model" in timeline:
            last = timeline["last_model"]
            self.last[last] = self.last.get(last, 0) + 1
            for field in self.FIELDS:
                self.totals[field] += timeline[field]
        duration = result["inference_ms"]
        if self.slowest is None or duration > self.slowest["inference_ms"]:
            self.slowest = dict(timeline, inference_ms=duration,
                                seq=result.get("frame_seq"), epoch=result.get("frame_epoch"))

    def take_reports(self):
        if not self.modes:
            return []
        paired = sum(self.last.values())
        counts = " ".join(f"{mode}_frames={self.modes.get(mode, 0)}"
                          for mode in ("parallel", "serial", "yolo_only", "depth_error"))
        last = " ".join(f"{name}_last_frames={self.last.get(name, 0)}" for name in ("yolo", "depth", "tie"))
        means = " ".join(f"mean_{field}={self.totals[field] / paired:.2f}" if paired else f"mean_{field}=n/a"
                         for field in self.FIELDS)
        slow = " ".join(f"{key}={value:.2f}" if isinstance(value, float) else f"{key}={value}"
                        for key, value in self.slowest.items())
        reports = [f"[model-timeline] {counts} {last} {means}", f"[model-timeline-slow] {slow}"]
        self.__init__()
        return reports
