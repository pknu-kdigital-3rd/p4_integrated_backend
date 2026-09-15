from pathlib import Path
import torch
from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent.parent  # .../server
INDEX_HTML_PATH = BASE_DIR / "index.html"


def _default_inference_device() -> str:
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

    # --- SAM3 inference ---
    # These defaults mirror the SAM3.1 multiplex files on the Linux GPU host.
    # The SAM3 package itself is installed from its source checkout,
    # not from the regular project dependency index.
    SAM3_CHECKPOINT_PATH: str = "/workspace/models/sam3.1_multiplex.pt"
    # The upstream SAM3 repository currently references this package asset but
    # does not include it in the checkout, so setup downloads the compatible
    # OpenAI CLIP vocabulary into the shared models directory.
    SAM3_BPE_PATH: str = "/workspace/models/bpe_simple_vocab_16e6.txt.gz"
    SAM3_PROMPT: str = "person"
    SAM3_DEVICE: str = _default_inference_device()
    SAM3_SCORE_THRESHOLD: float = Field(default=0.5, ge=0.0, le=1.0)
    SAM3_MAX_DETECTIONS: int = Field(default=100, ge=1, le=1000)
    # SAM3.1 multiplex controls. FlashAttention 3 and torch.compile are
    # disabled by default because they are not available on every Ampere host.
    SAM3_MAX_NUM_OBJECTS: int = Field(default=16, ge=1, le=256)
    SAM3_MULTIPLEX_COUNT: int = Field(default=16, ge=1, le=256)
    SAM3_USE_FA3: bool = False
    SAM3_USE_ROPE_REAL: bool = False
    SAM3_COMPILE: bool = False
    SAM3_WARM_UP: bool = False
    SAM3_ASYNC_LOADING_FRAMES: bool = False

    # --- QR-synchronised monocular distance ---
    # Disabled unless a dataset and a per-session camera calibration are
    # explicitly supplied. Missing QR/data never blocks inference; it produces a
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
    # Legacy name retained because the Go relay and deployment contract use it
    # for the reliable encoded-frame feed; it is not a YOLO model setting.
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
        "SAM3_CHECKPOINT_PATH",
        "SAM3_BPE_PATH",
        "SAM3_PROMPT",
        "SAM3_DEVICE",
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

    @model_validator(mode="after")
    def _validate_turn_credentials(self) -> "Settings":
        if self.TURN_URL and not (self.TURN_USERNAME and self.TURN_PASSWORD):
            raise ValueError(
                "TURN_USERNAME and TURN_PASSWORD are required when TURN_URL is set"
            )
        return self


settings = Settings()
