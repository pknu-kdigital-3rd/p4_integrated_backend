from pathlib import Path
from typing import Literal

import torch
from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent.parent  # .../services/vision
INDEX_HTML_PATH = BASE_DIR / "index.html"


def _default_yolo_device() -> str:
    """Use CUDA only when this PyTorch wheel supports the installed GPU."""
    if not torch.cuda.is_available():
        return "cpu"
    try:
        major, minor = torch.cuda.get_device_capability(0)
        supported_arches = set(torch.cuda.get_arch_list())
        if f"sm_{major}{minor}" not in supported_arches:
            return "cpu"
    except (AssertionError, RuntimeError):
        return "cpu"
    return "cuda:0"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    # --- YOLO / inference ---
    # Segmentation checkpoints use the -seg suffix. Custom trained
    # segmentation checkpoints can be supplied through YOLO_MODEL as usual.
    YOLO_MODEL: str = str(BASE_DIR / "models" / "yolo26s-seg.pt")
    YOLO_DEVICE: str = _default_yolo_device()
    # Frames larger than this are aspect-preservingly scaled before BGR
    # materialization, then Ultralytics letterboxes the smaller image to its
    # stride-aligned input. Normalized outputs remain source-size invariant;
    # pixel boxes are mapped back by the inference worker.
    YOLO_MAX_IMGSZ: int = 640
    # FP16 is substantially faster on RTX-class CUDA GPUs. It is enabled by
    # default but is automatically ignored when YOLO_DEVICE is CPU.
    YOLO_HALF: bool = True
    # Preserve detail in the source-aligned segmentation masks. Operators can
    # disable this when inference latency matters more than polygon detail.
    YOLO_RETINA_MASKS: bool = True
    # Bound NMS and segmentation work for crowded frames. Increase this when
    # the application must publish more than 100 objects in one frame.
    YOLO_MAX_DETECTIONS: int = Field(default=100, ge=1, le=300)
    # Bound the device-side grid used for contour extraction. 640 preserves
    # detail by default; reduce this to trade polygon fidelity for latency.
    YOLO_MASK_CONTOUR_SIZE: int = Field(default=640, ge=32, le=640)
    # Optional contour simplification reduces JSON and browser work for masks
    # with noisy boundaries. Keep it off by default so polygon fidelity stays
    # identical until a deployment opts in.
    YOLO_MASK_POLYGON_SIMPLIFY: bool = False
    YOLO_MASK_POLYGON_EPSILON_RATIO: float = Field(default=0.002, ge=0.0, le=0.2)
    BBOX_FORMAT: Literal[
        "xyxy_normalized", "xyxy_pixels", "xywh_normalized", "xywh_pixels"
    ] = "xyxy_normalized"
    # Lower bound on what reaches the tracker. ByteTrack's second association
    # stage can recover an already-established track from a detection this
    # weak, which is what stops a box blinking out when confidence dips; a new
    # track still has to clear the higher new_track_thresh in the tracker
    # config, so weak noise cannot start one.
    CONF_THRESHOLD_LOW: float = Field(default=0.1, ge=0.0, le=1.0)
    # In `queue` mode ordered no-drop delivery gives the motion-model tracker
    # every frame. `latest` trades some temporal updates for fresh inference
    # when the model cannot keep up. Disable to use stateless per-frame
    # detection.
    YOLO_TRACKING: bool = True
    YOLO_TRACKER_CONFIG: str = str(BASE_DIR / "app" / "trackers" / "bytetrack.yaml")
    # `latest` keeps only the newest queued frame for the next inference call;
    # skipped media frames still pass through with the last completed
    # detections so the H.264 playback sequence remains decodable. `queue`
    # retains arrival order until its finite queue is full, then drops new
    # inference work without blocking ingest.
    YOLO_FRAME_DROP_POLICY: Literal["latest", "queue"] = "latest"
    # This is the decoded-frame handoff, not the encoded relay backlog. Keep it
    # small because every entry owns a PyAV VideoFrame and its encoded AU.
    YOLO_INFERENCE_QUEUE_SIZE: int = Field(default=1, ge=1, le=120)

    # --- QR-synchronised monocular distance ---
    # Disabled unless a dataset and a per-session camera calibration are
    # explicitly supplied.  Missing QR/data never blocks YOLO; it produces a
    # nullable distance with a diagnostic status instead.
    MONOCULAR_ENABLED: bool = False
    MONOCULAR_DATASET_DIR: str | None = None
    MONOCULAR_CALIBRATION_FILE: str | None = None
    MONOCULAR_QR_MAX_AGE_MS: float = Field(default=200.0, ge=0.0, le=10_000.0)
    MONOCULAR_SOURCE_MAX_DELTA_MS: float = Field(default=50.0, ge=0.0, le=10_000.0)
    MONOCULAR_IMU_MAX_DELTA_MS: float = Field(default=50.0, ge=0.0, le=10_000.0)

    # --- Server ---
    HOST: str = "127.0.0.1"
    PORT: int = 39011
    FORWARDED_ALLOW_IPS: str = "127.0.0.1"
    TLS_CERT_FILE: str | None = None
    TLS_KEY_FILE: str | None = None

    # --- replay detection persistence ---
    RECORDING_ENABLED: bool = False
    NODE_INTERNAL_BASE_URL: str = "http://127.0.0.1:3000"
    NODE_INTERNAL_SERVICE_TOKEN: str | None = None
    RECORDING_DETECTION_QUEUE_SIZE: int = Field(default=256, ge=1, le=4096)
    # Store one replay detection sample for every N completed inference results.
    RECORDING_DETECTION_SAMPLE_EVERY_N_FRAMES: int = Field(
        default=1, ge=1, le=10_000
    )

    # --- TURN / ICE ---
    TURN_URL: str = "turn:10.174.96.119:39006?transport=udp"
    TURN_USERNAME: str = "user"
    TURN_PASSWORD: str = "pass"
    YOLO_FEED_SOCKET: str = "/tmp/poc-relay-yolo.sock"
    RELAY_KEYFRAME_URL: str = "http://127.0.0.1:39012/internal/request-keyframe"
    RELAY_STATUS_URL: str = "http://127.0.0.1:39012/internal/status"
    # Comma-separated operator origins allowed to receive presented-frame
    # telemetry via postMessage when this page is embedded (e.g.
    # "https://its.example.internal:39001"). Empty allows only a parent page on
    # the same hostname as this Vision page.
    LIVE_VIEW_PARENT_ORIGINS: str = ""
    CLIENT_PREFETCH_SECONDS: float = Field(default=2.0, ge=0.1, le=30.0)
    CLIENT_LOW_WATERMARK_SECONDS: float = Field(default=0.5, ge=0.05, le=10.0)
    CLIENT_BUFFER_MAX_BYTES: int = Field(default=64 * 1024 * 1024, ge=1)
    INFERENCE_RETRY_COUNT: int = Field(default=3, ge=1, le=10)
    INFERENCE_RETRY_DELAYS: tuple[float, ...] = (0.1, 0.5)
    BACKLOG_MAX_SECONDS: float = Field(default=30.0, ge=1.0, le=3600.0)
    BACKLOG_MAX_BYTES: int = Field(default=256 * 1024 * 1024, ge=1)
    METRICS_LOG_INTERVAL_SECONDS: float = Field(default=5.0, ge=1.0, le=60.0)
    ENABLE_PYTHON_ALLOC_PROFILE: bool = False
    PYTHON_ALLOC_PROFILE_INTERVAL_SECONDS: float = Field(
        default=30.0, ge=5.0, le=3600.0
    )
    PYTHON_ALLOC_PROFILE_TOP: int = Field(default=20, ge=1, le=100)

    @field_validator(
        "YOLO_MODEL",
        "YOLO_DEVICE",
        "YOLO_TRACKER_CONFIG",
        "HOST",
        "FORWARDED_ALLOW_IPS",
        "TURN_URL",
        "TURN_USERNAME",
        "YOLO_FEED_SOCKET",
        "RELAY_KEYFRAME_URL",
        "RELAY_STATUS_URL",
        "MONOCULAR_DATASET_DIR",
        "MONOCULAR_CALIBRATION_FILE",
        "TLS_CERT_FILE",
        "TLS_KEY_FILE",
        "NODE_INTERNAL_BASE_URL",
        "NODE_INTERNAL_SERVICE_TOKEN",
        mode="before",
    )
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip() if isinstance(v, str) else v

    @field_validator("YOLO_MODEL")
    @classmethod
    def _resolve_yolo_model_path(cls, v: str) -> str:
        path = Path(v).expanduser()
        if not path.is_absolute():
            if path.parts and path.parts[0].lower() == "models":
                path = BASE_DIR / path
            else:
                path = BASE_DIR / "models" / path
        return str(path.resolve())

    @field_validator("BBOX_FORMAT", mode="before")
    @classmethod
    def _normalize_bbox_format(cls, v: str) -> str:
        return v.strip().lower() if isinstance(v, str) else v

    @field_validator("YOLO_FRAME_DROP_POLICY", mode="before")
    @classmethod
    def _normalize_frame_drop_policy(cls, v: str) -> str:
        return v.strip().lower() if isinstance(v, str) else v

    @field_validator("YOLO_MAX_IMGSZ")
    @classmethod
    def _validate_imgsz(cls, v: int) -> int:
        if v <= 0 or v % 32 != 0:
            raise ValueError("YOLO_MAX_IMGSZ must be a positive multiple of 32")
        return v

    @model_validator(mode="after")
    def _validate_turn_credentials(self) -> "Settings":
        if self.TURN_URL and not (self.TURN_USERNAME and self.TURN_PASSWORD):
            raise ValueError(
                "TURN_USERNAME and TURN_PASSWORD are required when TURN_URL is set"
            )
        return self


settings = Settings()
