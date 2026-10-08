"""Generate a portable, every-frame inference bundle on the inference machine."""
from __future__ import annotations

import argparse
from fractions import Fraction
import json
from pathlib import Path
import tempfile

import av
import orjson

from app.core.state import InferenceFrame
from app.services.inference_bundle import FORMAT_VERSION, TIME_BASE, InferenceBundle, file_identity

BASE_DIR = Path(__file__).resolve().parent


def create_bundle(video: Path, output: Path, infer, metadata: dict) -> Path:
    """Infer sequentially. Publish a new directory only after validating all output."""
    video, output = video.resolve(), output.resolve()
    if output.exists():
        raise ValueError(f"Output already exists; choose a new directory: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".vision-precompute-", dir=output.parent) as temporary:
        bundle = Path(temporary) / "bundle"
        bundle.mkdir()
        index = []
        first_time = None
        with av.open(str(video)) as source:
            if not source.streams.video:
                raise ValueError("Input has no video stream")
            stream = source.streams.video[0]
            origin = (stream.start_time or 0) * stream.time_base
            rate = stream.average_rate or Fraction(30)
            # H.264 yuv420p requires even dimensions. Infer at the exported
            # dimensions as well, so all coordinates remain source aligned.
            width, height = stream.width + stream.width % 2, stream.height + stream.height % 2
            with av.open(str(bundle / "playback.mp4"), "w", options={"movflags": "+faststart"}) as target, \
                    (bundle / "inference.jsonl").open("wb") as results:
                encoded = target.add_stream("libx264", rate=rate)
                encoded.width, encoded.height = width, height
                encoded.pix_fmt = "yuv420p"
                encoded.time_base = Fraction(1, TIME_BASE)
                encoded.codec_context.time_base = Fraction(1, TIME_BASE)
                encoded.options = {"preset": "fast", "crf": "18", "profile": "baseline", "bf": "0", "g": "30"}
                last_duration = round(TIME_BASE / rate)
                for seq, frame in enumerate(source.decode(stream)):
                    if frame.pts is None or frame.time_base is None:
                        raise ValueError(f"Frame {seq} has no presentation timestamp")
                    source_time = frame.pts * frame.time_base
                    if first_time is None:
                        first_time = source_time
                    pts = round((source_time - first_time) * TIME_BASE)
                    if index and pts <= index[-1][0]:
                        raise ValueError("Input timestamps must be strictly increasing at 90 kHz precision")
                    last_duration = (round(frame.duration * frame.time_base * TIME_BASE)
                                     if frame.duration else round(TIME_BASE / rate))
                    frame = frame.reformat(width=width, height=height, format="yuv420p")
                    frame.pts, frame.time_base = pts, Fraction(1, TIME_BASE)
                    frame.duration = max(1, last_duration)
                    inference_frame = InferenceFrame(seq, frame, pts, 1 / TIME_BASE, pts / TIME_BASE,
                                                     timestamp_us=round(pts * 1_000_000 / TIME_BASE))
                    result = infer(inference_frame)
                    if result.get("depth", {}).get("status") != "ok":
                        raise RuntimeError(f"Depth execution failed at frame {seq}: {result.get('depth')}")
                    # Source/session metadata belongs to playback, not this job.
                    saved = {key: value for key, value in result.items()
                             if key not in {"source", "frame_epoch", "frame_seq"}}
                    payload = orjson.dumps({"pts_90k": pts, "result": saved},
                                           option=orjson.OPT_SERIALIZE_NUMPY) + b"\n"
                    index.append([pts, results.tell(), len(payload)])
                    results.write(payload)
                    for packet in encoded.encode(frame):
                        target.mux(packet)
                    if seq % 100 == 0:
                        print(f"processed {seq + 1} frames; source time {pts / TIME_BASE:.2f}s", flush=True)
                for packet in encoded.encode(None):
                    target.mux(packet)
            if not index:
                raise ValueError("Input has no decodable frames")
            source_time_offset_ns = str(round((first_time - origin) * 1_000_000_000))
        # Verify actual encoded operations and timing, including delayed frames.
        with av.open(str(bundle / "playback.mp4")) as check:
            exported_stream = check.streams.video[0]
            duration = float(exported_stream.duration * exported_stream.time_base)
            actual = [round(frame.pts * frame.time_base * TIME_BASE) for frame in check.decode(video=0)]
        if actual != [row[0] for row in index]:
            raise ValueError("Exported video timestamps/frame count do not match inference")
        manifest = dict(metadata, version=FORMAT_VERSION, complete=True, time_base=TIME_BASE,
                        frame_count=len(index), frames=index, width=width, height=height,
                        duration=duration,
                        source_time_offset_ns=source_time_offset_ns,
                        source_video=file_identity(video), video=file_identity(bundle / "playback.mp4"),
                        results=file_identity(bundle / "inference.jsonl"))
        (bundle / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        page = (BASE_DIR / "review-template.html").read_text(encoding="utf-8")
        for name in ("live-view-distance-colors.js", "live-view-overlay.js", "inference-review.js"):
            page = page.replace(f"/* INLINE:{name} */", (BASE_DIR / name).read_text(encoding="utf-8"))
        (bundle / "review.html").write_text(page, encoding="utf-8")
        validated = InferenceBundle(bundle)
        for timestamp in validated.timestamps:
            validated.result_at(timestamp)
        bundle.rename(output)
    return output


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--video", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    from app.core.settings import settings
    if settings.VISION_INFERENCE_MODE != "inference":
        parser.error("Preprocessing requires VISION_INFERENCE_MODE=inference")
    import torch
    if not settings.YOLO_DEVICE.startswith("cuda") or not torch.cuda.is_available():
        parser.error("Preprocessing requires a CUDA GPU and YOLO_DEVICE=cuda:0 (or another CUDA device)")
    from app.services.depth import load_depth_estimator, make_depth_executor, SOURCE_REVISION, MODEL_REVISION
    from app.services.yolo import load_yolo_model, reset_tracker, run_yolo, tracker_confidence_config
    model = load_yolo_model()
    executor = make_depth_executor()
    try:
        # CUDA graphs and depth calls must share the worker that warmed them.
        depth = executor.submit(load_depth_estimator).result()
        reset_tracker(model)
        metadata = {
            "model_filename": Path(settings.YOLO_MODEL).name,
            "model_identity": file_identity(Path(settings.YOLO_MODEL)),
            "depth_source_revision": SOURCE_REVISION, "depth_model_revision": MODEL_REVISION,
            "torch_version": torch.__version__, "cuda_version": torch.version.cuda,
            "overlay_classes": model._p4_overlay_classes,
            "confidence_thresholds": tracker_confidence_config()[1] if settings.YOLO_TRACKING else None,
            "configuration": {key: value for key, value in settings.model_dump(mode="json").items()
                              if key.startswith(("YOLO_", "UNIDEPTH_")) or key in {"BBOX_FORMAT", "CONF_THRESHOLD_LOW", "VISION_FRAME_PREP"}},
        }
        output = create_bundle(args.video, args.output,
                               lambda frame: run_yolo(frame, model, depth, executor), metadata)
        print(f"Complete: {output}\nOpen review.html and select playback.mp4, manifest.json and inference.jsonl.")
    finally:
        executor.shutdown(wait=True, cancel_futures=True)


if __name__ == "__main__":
    main()
