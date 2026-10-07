"""Validate the real dataset and run one frame through the existing models."""
import asyncio
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "services/vision"))

from app.core.settings import settings
from app.core.state import InferenceFrame
from app.services.depth import load_depth_estimator, load_depth_on_worker, make_depth_executor
from app.services.server_source import ServerSource
from app.services.yolo import load_yolo_model, prepare_inference_inputs, run_yolo


async def check():
    source = ServerSource(settings)
    source.load()
    print(f"Dataset validated: {source.video}; {source.duration:.3f} seconds; {source.fps:g} FPS", flush=True)
    frames = source.frames(0)
    try:
        seconds, frame, encoded, keyframe = next(frames)
    finally:
        frames.close()
    # Loading alone is insufficient: exercise TensorRT, GPU contours and
    # UniDepth's xFormers attention through the actual application operation.
    model = load_yolo_model()
    executor = make_depth_executor()
    try:
        depth = await load_depth_on_worker(executor, load_depth_estimator)
        prepared = prepare_inference_inputs(frame, depth is not None)
        result = run_yolo(InferenceFrame(seq=0, frame=frame, pts=frame.pts, time_base=float(frame.time_base),
                         media_time=seconds, encoded=encoded, keyframe=keyframe, prepared=prepared),
                         model, depth, executor)
        print(f"One-frame inference passed: {result['width']} x {result['height']}", flush=True)
    finally:
        executor.shutdown(wait=True, cancel_futures=True)


if __name__ == "__main__":
    asyncio.run(check())
