from pathlib import Path
import re
from typing import Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent.parent  # .../services/vision
INDEX_HTML_PATH = BASE_DIR / "index.html"


def _default_yolo_device() -> str:
    """Use CUDA only when this PyTorch wheel supports the installed GPU."""
    import torch
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

    VISION_SOURCE: Literal["server", "relay"] = "server"
    VISION_INFERENCE_MODE: Literal["inference", "cached"] = "inference"
    VISION_CACHE_DIR: str = ""
    SERVER_DATASET_DIR: str = str(BASE_DIR / "dataset")
    SERVER_VIDEO_FILE: str = "video.mp4"
    SERVER_GPS_FILE: str = "gps.csv"
    SERVER_IMU_FILE: str = "imu.csv"
    SERVER_VEHICLE_ID: str = "server"
    # Source clock at video time zero; defaults to the first GPS timestamp.
    SERVER_SOURCE_START_NS: int | None = Field(default=None, gt=0)

    @field_validator("SERVER_SOURCE_START_NS", mode="before")
    @classmethod
    def empty_source_start(cls, value):
        return None if value == "" else value

    # --- YOLO / inference ---
    # Segmentation checkpoints use the -seg suffix. Custom trained
    # segmentation checkpoints can be supplied through YOLO_MODEL as usual.
    YOLO_MODEL: str = str(BASE_DIR / "models" / "yolo26s-seg.pt")
    # Comma-separated model class names (or numeric IDs). Empty keeps all classes.
    YOLO_CLASSES: str = ""
    YOLO_DEVICE: str = "auto"
    # Frames larger than this are aspect-preservingly scaled before BGR
    # materialization, then Ultralytics letterboxes the smaller image to its
    # stride-aligned input. Normalized outputs remain source-size invariant;
    # pixel boxes are mapped back by the inference worker.
    YOLO_MAX_IMGSZ: int = 640
    # Model input dimensions. ``auto`` keeps the existing aspect-preserving
    # max-side behavior; ``source`` uses decoded frame dimensions; an
    # explicit value such as ``720x1280`` (height x width) keeps a rectangular
    # model input matching the camera image.
    YOLO_INFERENCE_SIZE: str = "auto"
    # FP16 is substantially faster on RTX-class CUDA GPUs. It is enabled by
    # default but is automatically ignored when YOLO_DEVICE is CPU.
    YOLO_HALF: bool = True
    VISION_FRAME_PREP: Literal["shared", "independent"] = "shared"
    # ``decode`` converts each frame to model inputs on the decode thread, so
    # the inference worker starts the models without a YUV -> BGR step.
    # ``inference`` keeps the conversion inside run_yolo (for comparison).
    VISION_FRAME_PREP_THREAD: Literal["decode", "inference"] = "decode"
    YOLO_TRT_EXECUTION: Literal["async", "sync"] = "async"
    YOLO_PINNED_INPUT: bool = True
    # Preserve detail in the source-aligned segmentation masks. Operators can
    # disable this when inference latency matters more than polygon detail.
    YOLO_RETINA_MASKS: bool = True
    # Bound NMS and segmentation work for crowded frames. Increase this when
    # the application must publish more than 100 objects in one frame.
    YOLO_MAX_DETECTIONS: int = Field(default=100, ge=1, le=300)
    # Bound the device-side grid used for contour extraction. 640 preserves
    # detail by default; reduce this to trade polygon fidelity for latency.
    YOLO_MASK_CONTOUR_SIZE: int = Field(default=640, ge=32, le=640)
    # GPU mode traces contours before transfer. Packed/legacy retain CPU tracing
    # for comparisons. CPU inference keeps the ordinary contour path.
    YOLO_MASK_TRANSFER: Literal["gpu", "packed", "legacy"] = "gpu"
    YOLO_GPU_CONTOUR_MAX_COMPONENTS: int = Field(default=32, ge=1, le=256)
    YOLO_MASK_MAX_POINTS: int = Field(default=256, ge=3, le=4096)
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
    # Overrides for the tracker config's two confidence thresholds; unset
    # keeps the YAML values. APPEAR is new_track_thresh: a new box must
    # reach it to be shown. KEEP is track_low_thresh: an established box
    # stays shown down to it (the anti-flicker threshold). KEEP <= APPEAR.
    YOLO_APPEAR_CONFIDENCE: float | None = Field(default=None, ge=0.0, le=1.0)
    YOLO_KEEP_CONFIDENCE: float | None = Field(default=None, ge=0.0, le=1.0)
    # `latest` keeps only the newest queued frame for the next inference call;
    # skipped media frames still pass through with the last completed
    # detections so the H.264 playback sequence remains decodable. `queue`
    # retains arrival order until its finite queue is full, then drops new
    # inference work without blocking ingest.
    YOLO_FRAME_DROP_POLICY: Literal["latest", "queue"] = "latest"
    # This is the decoded-frame handoff, not the encoded relay backlog. Keep it
    # small because every entry owns a PyAV VideoFrame and its encoded AU.
    YOLO_INFERENCE_QUEUE_SIZE: int = Field(default=1, ge=1, le=120)

    # --- UniDepth metric distance ---
    UNIDEPTH_MODEL_DIR: str = str(BASE_DIR / "models" / "unidepth-v2-vitb14")
    # Defaults to YOLO_DEVICE. The entrypoint sets cuda:1 when a separate
    # UNIDEPTH_GPU_INDEX is selected.
    UNIDEPTH_DEVICE: str | None = None
    # yolo shares YOLO's resized image; source uses the decoded frame; HxW
    # selects an independent depth input grid with the same field of view.
    UNIDEPTH_INFERENCE_SIZE: str = "yolo"
    # UniDepth's internal inference pixel budget increases from 0 to 9.
    # Level 2 trades some fine depth detail for lower per-frame latency.
    UNIDEPTH_RESOLUTION_LEVEL: int = Field(default=2, ge=0, le=9)
    UNIDEPTH_COMPILE: bool = True
    UNIDEPTH_COMPILE_MODE: Literal["default", "reduce-overhead"] = "reduce-overhead"
    UNIDEPTH_DISTANCE_REGION: Literal["mask", "inner_box"] = "mask"
    UNIDEPTH_DISTANCE_BOX_SCALE: float = Field(default=0.5, gt=0.0, le=1.0)
    # Fixed calibration from 20260827_longtrip_merged/intrinsics.json.
    UNIDEPTH_CAMERA_INTRINSIC: tuple[tuple[float, float, float], ...] = (
        (920.0, 0.0, 640.0),
        (0.0, 690.0, 360.0),
        (0.0, 0.0, 1.0),
    )
    UNIDEPTH_CALIBRATION_WIDTH: int = Field(default=1280, ge=1, le=16384)
    UNIDEPTH_CALIBRATION_HEIGHT: int = Field(default=720, ge=1, le=16384)
    LOG_TELEMETRY_ACCESS: bool = False

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
    TURN_URL: str = "turn:10.174.96.119:39004?transport=udp"
    TURN_USERNAME: str = "user"
    TURN_PASSWORD: str = "replace-with-strong-turn-password"
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
    # Publish a frame with the last overlay when its own inference has not
    # finished this long after decode, so one slow inference cannot stall the
    # in-order browser stream. A result that finishes later still replaces the
    # stored item and becomes the overlay for following frames. 0 disables.
    PLAYBACK_DEADLINE_MS: float = Field(default=50.0, ge=0.0, le=10000.0)
    INFERENCE_RETRY_COUNT: int = Field(default=3, ge=1, le=10)
    INFERENCE_RETRY_DELAYS: tuple[float, ...] = (0.1, 0.5)
    BACKLOG_MAX_SECONDS: float = Field(default=30.0, ge=1.0, le=3600.0)
    BACKLOG_MAX_BYTES: int = Field(default=256 * 1024 * 1024, ge=1)
    PLAYBACK_MAX_FRAMES: int = Field(default=1800, ge=1, le=3600)
    METRICS_LOG_INTERVAL_SECONDS: float = Field(default=5.0, ge=1.0, le=60.0)
    VISION_GC_GEN0_THRESHOLD: int | None = Field(default=None, ge=100, le=1_000_000)
    ENABLE_PYTHON_ALLOC_PROFILE: bool = False
    # Opt-in, bounded profiles of actual YOLO/depth calls using thread CPU time.
    VISION_CPU_PROFILE_FRAMES: int = Field(default=0, ge=0, le=1000)
    VISION_CPU_PROFILE_WARMUP_FRAMES: int = Field(default=60, ge=0, le=10000)
    VISION_CPU_PROFILE_DIR: str = "/var/cache/p4-vision-compile/cpu-profile"
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
        "UNIDEPTH_MODEL_DIR",
        "UNIDEPTH_DEVICE",
        "TLS_CERT_FILE",
        "TLS_KEY_FILE",
        "NODE_INTERNAL_BASE_URL",
        "NODE_INTERNAL_SERVICE_TOKEN",
        mode="before",
    )
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip() if isinstance(v, str) else v

    @field_validator("YOLO_APPEAR_CONFIDENCE", "YOLO_KEEP_CONFIDENCE", mode="before")
    @classmethod
    def _blank_confidence_is_unset(cls, v: object) -> object:
        # Compose passes `${VAR:-}` as an empty string when it is not set.
        return None if isinstance(v, str) and not v.strip() else v

    @field_validator("VISION_GC_GEN0_THRESHOLD", mode="before")
    @classmethod
    def _blank_gc_threshold_is_unset(cls, v: object) -> object:
        return None if isinstance(v, str) and not v.strip() else v

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

    @field_validator("UNIDEPTH_MODEL_DIR")
    @classmethod
    def _resolve_unidepth_model_path(cls, v: str) -> str:
        path = Path(v).expanduser()
        if not path.is_absolute():
            path = BASE_DIR / path
        return str(path.resolve())

    @field_validator("UNIDEPTH_CAMERA_INTRINSIC")
    @classmethod
    def _validate_unidepth_camera_intrinsic(cls, value):
        if len(value) != 3 or any(len(row) != 3 for row in value):
            raise ValueError("UNIDEPTH_CAMERA_INTRINSIC must be a 3x3 matrix")
        return value

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

    @field_validator("YOLO_INFERENCE_SIZE", mode="before")
    @classmethod
    def _normalize_inference_size(cls, v: str) -> str:
        if not isinstance(v, str):
            raise ValueError("YOLO_INFERENCE_SIZE must be auto, source, or HxW")
        value = v.strip().lower()
        if value in {"", "auto", "source", "original"}:
            return "source" if value == "original" else (value or "auto")
        match = re.fullmatch(r"(\d+)\s*(?:x|,|\s)\s*(\d+)", value)
        if match is None:
            raise ValueError(
                "YOLO_INFERENCE_SIZE must be auto, source, or HxW "
                "(for example 720x1280)"
            )
        height, width = (int(group) for group in match.groups())
        if not 32 <= height <= 4096 or not 32 <= width <= 4096:
            raise ValueError("YOLO_INFERENCE_SIZE dimensions must be between 32 and 4096")
        return f"{height}x{width}"

    @model_validator(mode="after")
    def _resolve_inference_mode(self) -> "Settings":
        if self.VISION_INFERENCE_MODE == "cached":
            if self.VISION_SOURCE != "server":
                raise ValueError("cached inference requires VISION_SOURCE=server")
            self.YOLO_DEVICE = "cpu"
        elif self.YOLO_DEVICE == "auto":
            self.YOLO_DEVICE = _default_yolo_device()
        return self

    @model_validator(mode="after")
    def _validate_turn_credentials(self) -> "Settings":
        if self.TURN_URL and not (self.TURN_USERNAME and self.TURN_PASSWORD):
            raise ValueError(
                "TURN_USERNAME and TURN_PASSWORD are required when TURN_URL is set"
            )
        return self

    @field_validator("UNIDEPTH_INFERENCE_SIZE", mode="before")
    @classmethod
    def _normalize_depth_inference_size(cls, value: str) -> str:
        if not isinstance(value, str):
            raise ValueError("UNIDEPTH_INFERENCE_SIZE must be yolo, source, or HxW")
        value = value.strip().lower()
        if value in {"", "yolo"}:
            return "yolo"
        if value in {"source", "original"}:
            return "source"
        match = re.fullmatch(r"(\d+)\s*(?:x|,|\s)\s*(\d+)", value)
        if match is None:
            raise ValueError("UNIDEPTH_INFERENCE_SIZE must be yolo, source, or HxW (for example 360x640)")
        height, width = map(int, match.groups())
        if not 32 <= height <= 4096 or not 32 <= width <= 4096:
            raise ValueError("UNIDEPTH_INFERENCE_SIZE dimensions must be between 32 and 4096")
        return f"{height}x{width}"


settings = Settings()
