# SAM3 segmentation backend

The `sam3` branch adds SAM3 as an alternative segmentation backend. It uses
the image/text-prompt API shown in `E:/project4/temp/sam3_ex01.ipynb` and emits
the same normalized box/polygon schema as the existing YOLO backend.

## Linux GPU setup

Install the SAM3 source checkout into the vision service's Python environment.
The checkout must contain `sam3/model_builder.py` and
`sam3/model/sam3_image_processor.py`:

```bash
cd /workspace/p4_integrated_backend/services/vision
uv pip install -e /workspace/sam3
```

Place the model files at the paths used by the example notebook, or override
them in the environment:

```bash
export SEGMENTATION_BACKEND=sam3
export SAM3_CHECKPOINT_PATH=/workspace/models/sam3.pt
export SAM3_BPE_PATH=/workspace/sam3/sam3/assets/bpe_simple_vocab_16e6.txt.gz
export SAM3_PROMPT=person
export SAM3_DEVICE=cuda:0
export SAM3_SCORE_THRESHOLD=0.5
```

The service loads SAM3 during startup and fails fast with the missing package,
checkpoint, or vocabulary path if setup is incomplete. The browser displays
the checkpoint filename in the live-view page.

SAM3 is prompt-based rather than class-trained like YOLO. Each returned item
uses `SAM3_PROMPT` as its class label and has a normalized bounding box plus a
polygon extracted from the returned mask. SAM3 does not use the YOLO
ByteTrack state, so the browser's existing overlay smoothing remains the
available temporal stabilization.

## YOLO fallback

To run the original backend, set:

```bash
export SEGMENTATION_BACKEND=yolo
```

The YOLO settings and checkpoint are otherwise unchanged.

