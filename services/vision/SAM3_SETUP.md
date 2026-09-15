# SAM3.1 multiplex segmentation backend

The `sam3` branch uses SAM3.1 multiplex as its segmentation backend. It uses
the official video-predictor API and emits
the normalized box/polygon schema consumed by the browser overlay.

## Linux GPU setup

Install the SAM3 source checkout into the vision service's Python environment.
The checkout must contain `sam3/model_builder.py` and
`sam3/model/sam3_multiplex_video_predictor.py`:

```bash
cd /workspace/p4_integrated_backend/services/vision
uv pip install -e /workspace/sam3
```

Place the model files at the paths used by the example notebook, or override
them in the environment:

```bash
export SAM3_SOURCE_DIR=/workspace/sam3
export SAM3_CHECKPOINT_PATH=/workspace/models/sam3.1_multiplex.pt
export SAM3_BPE_PATH=/workspace/models/bpe_simple_vocab_16e6.txt.gz
export SAM3_BPE_URL=https://github.com/openai/CLIP/raw/main/clip/bpe_simple_vocab_16e6.txt.gz
export SAM3_PROMPT=person
export SAM3_DEVICE=cuda:0
export SAM3_SCORE_THRESHOLD=0.5
```

The service loads SAM3.1 during startup and fails fast with the missing package,
checkpoint, or vocabulary path if setup is incomplete. The browser displays
the checkpoint filename in the live-view page.

The BPE vocabulary is not currently included in the SAM3 Git checkout. The
one-command Linux setup downloads the compatible OpenAI CLIP vocabulary from
`SAM3_BPE_URL` into `SAM3_BPE_PATH` before starting Vision.

SAM3.1 is prompt-based rather than class-trained like YOLO. Each returned item
uses `SAM3_PROMPT` as its class label and has a normalized bounding box plus a
polygon extracted from the returned mask. The adapter keeps one multiplex
video session alive and appends decoded relay frames to it, so returned items
include stable `track_id` values when the model can associate an object across
frames.
