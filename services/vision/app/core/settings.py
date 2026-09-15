from pathlib import Path
from typing import Literal

import torch
from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent.parent  # .../server
INDEX_HTML_PATH = BASE_DIR / "index.html"


def _default_fastsam_device() -> str:
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

    # --- FastSAM / inference ---
    # Keep the YOLO_* names for compatibility with the existing relay and
    # deployment contract; YOLO_FEED_SOCKET is the socket name, while this
    # model path now selects Ultralytics FastSAM.
    YOLO_MODEL: str = "FastSAM-s.pt"
    YOLO_DEVICE: str = _default_fastsam_device()
    # FastSAM resizes each frame to imgsz and rescales outputs to source space.
    YOLO_MAX_IMGSZ: int = 640
    YOLO_HALF: bool = True
    FASTSAM_PROMPT: str = "person"
    FASTSAM_IOU: float = Field(default=0.9, ge=0.0, le=1.0)
    BBOX_FORMAT: Literal[
        "xyxy_normalized", "xyxy_pixels", "xywh_normalized", "xywh_pixels"
    ] = "xyxy_normalized"
    # Lower bound on what reaches the tracker. ByteTrack's second association
    # stage can recover an already-established track from a detection this
    # weak, which is what stops a box blinking out when confidence dips; a new
    # track still has to clear the higher new_track_thresh in the tracker
    # config, so weak noise cannot start one.
    CONF_THRESHOLD_LOW: float = Field(default=0.1, ge=0.0, le=1.0)
    # Ordered no-drop delivery is what makes a motion-model tracker usable
    # here: frame N+1 always follows N, so association never sees a gap.
    # Disable to fall back to stateless per-frame detection.
    YOLO_TRACKING: bool = True
    YOLO_TRACKER_CONFIG: str = str(BASE_DIR / "app" / "trackers" / "bytetrack.yaml")

    # --- QR-synchronised monocular distance ---
    # Disabled unless a dataset and a per-session camera calibration are
    # explicitly supplied. Missing QR/data never blocks FastSAM; it produces a
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

    # --- TURN / ICE ---
    TURN_URL: str = "turn:10.174.96.95:3478?transport=udp"
    TURN_USERNAME: str = "user"
    TURN_PASSWORD: str = "pass"
    YOLO_FEED_SOCKET: str = "/tmp/poc-relay-yolo.sock"
    RELAY_KEYFRAME_URL: str = "http://127.0.0.1:39012/internal/request-keyframe"
    RELAY_STATUS_URL: str = "http://127.0.0.1:39012/internal/status"
    CLIENT_PREFETCH_SECONDS: float = Field(default=2.0, ge=0.1, le=30.0)
    CLIENT_LOW_WATERMARK_SECONDS: float = Field(default=0.5, ge=0.05, le=10.0)
    CLIENT_BUFFER_MAX_BYTES: int = Field(default=64 * 1024 * 1024, ge=1)
    INFERENCE_RETRY_COUNT: int = Field(default=3, ge=1, le=10)
    INFERENCE_RETRY_DELAYS: tuple[float, ...] = (0.1, 0.5)
    BACKLOG_MAX_SECONDS: float = Field(default=30.0, ge=1.0, le=3600.0)
    BACKLOG_MAX_BYTES: int = Field(default=256 * 1024 * 1024, ge=1)

    @field_validator(
        "YOLO_MODEL",
        "YOLO_DEVICE",
        "FASTSAM_PROMPT",
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
        mode="before",
    )
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip() if isinstance(v, str) else v

    @field_validator("BBOX_FORMAT", mode="before")
    @classmethod
    def _normalize_bbox_format(cls, v: str) -> str:
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
