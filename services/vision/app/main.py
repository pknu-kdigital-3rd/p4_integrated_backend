import asyncio
import json
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import internal, pages, playback
from app.api.internal import sync_android_live_from_relay
from app.core.state import AppState
from app.services.yolo import (
    frame_receiver,
    load_central_tracker,
    load_yolo_models,
    yolo_worker,
)
from app.services.monocular import MonocularTimeline, QRResolver
from app.core.settings import settings


@asynccontextmanager
async def lifespan(app: FastAPI):
    state = AppState()
    app.state.app_state = state

    if settings.MONOCULAR_ENABLED:
        # Keep the resolver alive even when the sidecars are unavailable. The
        # browser then receives an explicit `dataset_unavailable` diagnostic
        # instead of silently omitting the monocular field altogether.
        state.monocular_resolver = QRResolver(settings.MONOCULAR_QR_MAX_AGE_MS)
        if not settings.MONOCULAR_DATASET_DIR:
            print("monocular distance unavailable: MONOCULAR_DATASET_DIR is empty")
        else:
            try:
                state.monocular_timeline = MonocularTimeline.load(
                    settings.MONOCULAR_DATASET_DIR,
                    settings.MONOCULAR_CALIBRATION_FILE,
                )
                print(
                    "monocular distance enabled: "
                    f"dataset={settings.MONOCULAR_DATASET_DIR} "
                    f"calibrated={state.monocular_timeline.calibration is not None}"
                )
            except (OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
                print(f"monocular distance unavailable: {exc}")

    # Explicit device selection rather than relying on Ultralytics' implicit
    # per-call auto-detection, so the chosen device is logged once at startup
    # and stays fixed for the life of the process.
    state.yolo_models = load_yolo_models()
    state.yolo_model = state.yolo_models[0]
    if len(state.yolo_models) > 1 and settings.YOLO_TRACKING:
        state.central_tracker = load_central_tracker()

    # Reference the tasks for the lifetime of the app (held by this suspended
    # generator frame across the yield below) - asyncio only keeps a weak
    # reference internally, so an unreferenced task can be garbage-collected
    # mid-run at any time, permanently killing background work with no error
    # and no restart. This bit us in practice: frame_receiver's task was
    # silently destroyed under GC pressure, which looked like an unrelated
    # TCP "broken pipe" on the Go relay's side minutes later.
    frame_receiver_task = asyncio.create_task(frame_receiver(state))
    yolo_worker_task = asyncio.create_task(yolo_worker(state))
    # Backgrounded, not awaited here: it retries a few times over ~1.5s if
    # the relay isn't reachable yet, and startup shouldn't block on that.
    android_live_sync_task = asyncio.create_task(sync_android_live_from_relay(state))

    yield

    # Without this, Ctrl+C leaves these infinite-loop/background tasks
    # running with nothing waiting on them - uvicorn's shutdown has nothing
    # to block on to know they've actually stopped, so the process doesn't
    # exit cleanly. CancelledError isn't an Exception subclass (Python 3.8+),
    # so none of these tasks' own exception handling swallows this.
    frame_receiver_task.cancel()
    yolo_worker_task.cancel()
    android_live_sync_task.cancel()
    await asyncio.gather(
        frame_receiver_task, yolo_worker_task, android_live_sync_task, return_exceptions=True
    )


app = FastAPI(lifespan=lifespan, title="Android to Web Relay YOLO Stream")


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
app.include_router(pages.router)
