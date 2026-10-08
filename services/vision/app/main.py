import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import internal, pages, playback, telemetry
from app.api.internal import sync_android_live_from_relay
from app.core.state import AppState
from app.core.settings import settings
from app.services.access_logs import configure_telemetry_access_logging
from app.services.gc_runtime import _freeze_loaded_objects, configure_gc
from app.services.metrics import metrics_worker
from app.services.recording_detections import RecordingDetectionWriter

configure_telemetry_access_logging(settings.LOG_TELEMETRY_ACCESS)


@asynccontextmanager
async def lifespan(app: FastAPI):
    state = AppState()
    app.state.app_state = state
    detection_writer = RecordingDetectionWriter(
        settings.NODE_INTERNAL_BASE_URL,
        settings.NODE_INTERNAL_SERVICE_TOKEN
        if settings.RECORDING_ENABLED and settings.VISION_INFERENCE_MODE == "inference" else None,
        settings.RECORDING_DETECTION_QUEUE_SIZE,
        sample_every_n_frames=settings.RECORDING_DETECTION_SAMPLE_EVERY_N_FRAMES,
    )
    if detection_writer.enabled:
        state.recording_writer = detection_writer
        print(
            "replay detection persistence enabled: "
            f"node={settings.NODE_INTERNAL_BASE_URL}; "
            f"queue={settings.RECORDING_DETECTION_QUEUE_SIZE}; "
            "sample_every_n_frames="
            f"{settings.RECORDING_DETECTION_SAMPLE_EVERY_N_FRAMES}",
            flush=True,
        )

    # Explicit device selection rather than relying on Ultralytics' implicit
    # per-call auto-detection, so the chosen device is logged once at startup
    # and stays fixed for the life of the process.
    if settings.VISION_INFERENCE_MODE == "inference":
        from app.services.depth import load_depth_estimator, load_depth_on_worker, make_depth_executor
        from app.services.yolo import load_yolo_model
        state.yolo_model = load_yolo_model()
        state.depth_executor = make_depth_executor()
        state.depth_model = await load_depth_on_worker(state.depth_executor, load_depth_estimator)
    configure_gc(settings.VISION_GC_GEN0_THRESHOLD)
    _freeze_loaded_objects("Vision cached startup" if settings.VISION_INFERENCE_MODE == "cached" else "Vision model startup")

    # Reference the tasks for the lifetime of the app (held by this suspended
    # generator frame across the yield below) - asyncio only keeps a weak
    # reference internally, so an unreferenced task can be garbage-collected
    # mid-run at any time, permanently killing background work with no error
    # and no restart. This bit us in practice: frame_receiver's task was
    # silently destroyed under GC pressure, which looked like an unrelated
    # TCP "broken pipe" on the Go relay's side minutes later.
    if settings.VISION_SOURCE == "server":
        from app.services.server_source import ServerSource, server_frame_receiver
        state.server_source = ServerSource(settings)
        if settings.VISION_INFERENCE_MODE == "cached":
            # Validate the bundle before reporting startup success. No models
            # or inference imports are permitted along this path.
            await asyncio.to_thread(state.server_source.load)
        frame_receiver_task = asyncio.create_task(server_frame_receiver(state))
    else:
        from app.services.yolo import frame_receiver
        frame_receiver_task = asyncio.create_task(frame_receiver(state))
    yolo_worker_task = None
    if settings.VISION_INFERENCE_MODE == "inference":
        from app.services.yolo import yolo_worker
        yolo_worker_task = asyncio.create_task(yolo_worker(state))
    metrics_task = asyncio.create_task(metrics_worker(state))
    detection_writer_task = (
        asyncio.create_task(detection_writer.run(state.metrics))
        if detection_writer.enabled
        else None
    )
    # Backgrounded, not awaited here: it retries a few times over ~1.5s if
    # the relay isn't reachable yet, and startup shouldn't block on that.
    android_live_sync_task = asyncio.create_task(sync_android_live_from_relay(state)) if settings.VISION_SOURCE == "relay" else None

    yield

    # Without this, Ctrl+C leaves these infinite-loop/background tasks
    # running with nothing waiting on them - uvicorn's shutdown has nothing
    # to block on to know they've actually stopped, so the process doesn't
    # exit cleanly. CancelledError isn't an Exception subclass (Python 3.8+),
    # so none of these tasks' own exception handling swallows this.
    frame_receiver_task.cancel()
    if yolo_worker_task is not None:
        yolo_worker_task.cancel()
    metrics_task.cancel()
    if android_live_sync_task is not None:
        android_live_sync_task.cancel()
    await asyncio.gather(
        frame_receiver_task,
        *([yolo_worker_task] if yolo_worker_task is not None else []),
        metrics_task,
        *([android_live_sync_task] if android_live_sync_task is not None else []),
        return_exceptions=True,
    )
    if detection_writer_task is not None:
        detection_writer.stop()
        try:
            await asyncio.wait_for(detection_writer_task, timeout=12.0)
        except asyncio.TimeoutError:
            detection_writer_task.cancel()
            await asyncio.gather(detection_writer_task, return_exceptions=True)
    if state.depth_executor is not None:
        await asyncio.to_thread(
            state.depth_executor.shutdown, wait=True, cancel_futures=True
        )
        state.depth_executor = None
        state.depth_model = None


app = FastAPI(lifespan=lifespan, title="Server video inference")


@app.get("/health/live")
async def health_live():
    """Ingress liveness check; it does not create a playback session."""
    return {"status": "ok"}


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(playback.router)
app.include_router(internal.router)
app.include_router(telemetry.router)
app.include_router(pages.router)
