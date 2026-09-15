from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from time import perf_counter, time
from typing import Any
from uuid import uuid4

import cv2
import numpy as np
import torch
from PIL import Image

from app.core.settings import settings
from app.core.state import InferenceFrame


@dataclass
class Sam3Model:
    """Loaded SAM3.1 multiplex predictor and its live inference session."""

    predictor: Any
    checkpoint_path: str
    prompt: str
    device: str
    session_id: str | None = None
    inference_state: dict[str, Any] | None = None
    frame_count: int = 0


def load_sam3_model() -> Sam3Model:
    """Load the official SAM3.1 multiplex video predictor."""

    try:
        from sam3.model_builder import build_sam3_multiplex_video_predictor
    except ModuleNotFoundError as exc:
        if exc.name == "sam3" or (exc.name and exc.name.startswith("sam3.")):
            raise RuntimeError(
                "SAM3.1 is unavailable. Install the SAM3 checkout (for example, "
                "`uv pip install -e /workspace/sam3`) in the Vision environment "
                "before starting the service."
            ) from exc
        raise RuntimeError(
            f"SAM3.1 import failed because dependency {exc.name!r} is unavailable. "
            "Install Vision dependencies and the SAM3 checkout again."
        ) from exc

    checkpoint = Path(settings.SAM3_CHECKPOINT_PATH)
    bpe_path = Path(settings.SAM3_BPE_PATH)
    if not checkpoint.is_file():
        raise FileNotFoundError(f"SAM3.1 checkpoint not found: {checkpoint}")
    if not bpe_path.is_file():
        raise FileNotFoundError(f"SAM3 BPE vocabulary not found: {bpe_path}")

    device = settings.SAM3_DEVICE
    if not device.startswith("cuda") or not torch.cuda.is_available():
        raise RuntimeError(
            "SAM3.1 multiplex requires CUDA; set SAM3_DEVICE to a CUDA device "
            "on the Linux GPU host."
        )

    print(f"SAM3.1 multiplex inference device: {device}")
    predictor = build_sam3_multiplex_video_predictor(
        checkpoint_path=str(checkpoint),
        bpe_path=str(bpe_path),
        max_num_objects=settings.SAM3_MAX_NUM_OBJECTS,
        multiplex_count=settings.SAM3_MULTIPLEX_COUNT,
        use_fa3=settings.SAM3_USE_FA3,
        use_rope_real=settings.SAM3_USE_ROPE_REAL,
        compile=settings.SAM3_COMPILE,
        warm_up=settings.SAM3_WARM_UP,
        default_output_prob_thresh=settings.SAM3_SCORE_THRESHOLD,
        async_loading_frames=settings.SAM3_ASYNC_LOADING_FRAMES,
    )
    return Sam3Model(
        predictor=predictor,
        checkpoint_path=str(checkpoint),
        prompt=settings.SAM3_PROMPT,
        device=device,
    )


def reset_sam3(sam3_model: Sam3Model | None) -> None:
    """Close the current live session while retaining the loaded predictor."""

    if sam3_model is None:
        return
    session_id = sam3_model.session_id
    if session_id:
        try:
            sam3_model.predictor.handle_request(
                {
                    "type": "close_session",
                    "session_id": session_id,
                    "run_gc_collect": True,
                }
            )
        except Exception as exc:  # pragma: no cover - defensive GPU cleanup
            print(f"SAM3.1 session cleanup failed: {exc}")
    sam3_model.session_id = None
    sam3_model.inference_state = None
    sam3_model.frame_count = 0


def _as_numpy(value: Any) -> np.ndarray:
    if value is None:
        return np.empty((0,))
    if hasattr(value, "detach"):
        return value.detach().float().cpu().numpy()
    return np.asarray(value)


def _normalised_xywh_box(box: Any) -> list[float] | None:
    values = _as_numpy(box).reshape(-1)
    if values.size < 4:
        return None
    x, y, width, height = map(float, values[:4])
    # SAM3.1 returns normalized [x, y, width, height]. Be tolerant of a
    # package revision returning pixel coordinates instead.
    if max(abs(x), abs(y), abs(width), abs(height)) > 1.5:
        return None
    left = max(0.0, min(1.0, x))
    top = max(0.0, min(1.0, y))
    right = max(0.0, min(1.0, x + width))
    bottom = max(0.0, min(1.0, y + height))
    if right <= left or bottom <= top:
        return None
    return [left, top, right, bottom]


def _normalised_polygon(mask: Any, width: int, height: int) -> list[list[float]] | None:
    array = np.squeeze(_as_numpy(mask))
    if array.ndim != 2 or not array.size:
        return None
    if array.shape != (height, width):
        array = cv2.resize(array, (width, height), interpolation=cv2.INTER_NEAREST)
    binary = (array > 0.5).astype(np.uint8)
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    contour = max(contours, key=cv2.contourArea)
    if len(contour) < 3:
        return None
    points = cv2.approxPolyDP(contour, epsilon=1.0, closed=True).reshape(-1, 2)
    if len(points) < 3:
        return None
    return [[float(x) / width, float(y) / height] for x, y in points]


def _append_frame(sam3_model: Sam3Model, image: Image.Image) -> None:
    """Append one decoded image to the predictor's existing video state.

    SAM3.1's public demo API normally receives a complete video up front. The
    relay supplies a live sequence instead, so we extend the same input batch
    and its per-frame bookkeeping before propagating the newly appended frame.
    """

    state = sam3_model.inference_state
    if state is None:
        raise RuntimeError("SAM3.1 inference state has not been initialized")
    from sam3.model.io_utils import load_resource_as_video_frames

    model = sam3_model.predictor.model
    images, _, _ = load_resource_as_video_frames(
        [image],
        image_size=state["image_size"],
        offload_video_to_cpu=False,
        img_mean=model.image_mean,
        img_std=model.image_std,
        async_loading_frames=False,
    )

    # Reuse the model's own constructor so new FindStage tensors exactly match
    # the package version installed on the Linux host.
    template: dict[str, Any] = {"device": state["device"], "constants": {}}
    model._construct_initial_input_batch(template, images)
    new_batch = template["input_batch"]
    input_batch = state["input_batch"]
    input_batch.img_batch.tensors = torch.cat(
        (input_batch.img_batch.tensors, new_batch.img_batch.tensors), dim=0
    )
    input_batch.find_inputs.append(new_batch.find_inputs[0])
    input_batch.find_targets.append(None)
    input_batch.find_metadatas.append(None)
    state["previous_stages_out"].append(None)
    state["per_frame_raw_point_input"].append(None)
    state["per_frame_raw_box_input"].append(None)
    state["per_frame_visual_prompt"].append(None)
    state["per_frame_geometric_prompt"].append(None)
    state["per_frame_cur_step"].append(0)
    state["num_frames"] += 1
    # The initial one-frame list is intentionally treated as an image by the
    # upstream loader. Once a second frame exists, enable temporal tracking.
    state["is_image_only"] = False


def _start_session(sam3_model: Sam3Model, image: Image.Image) -> dict[str, Any]:
    """Create and register a one-frame session without the base API's
    incompatible offload_state_to_cpu argument."""

    predictor = sam3_model.predictor
    state = predictor.model.init_state(
        resource_path=[image],
        offload_video_to_cpu=False,
        async_loading_frames=False,
    )
    session_id = str(uuid4())
    predictor._all_inference_states[session_id] = {
        "state": state,
        "session_id": session_id,
        "start_time": time(),
        "last_use_time": time(),
    }
    sam3_model.session_id = session_id
    sam3_model.inference_state = state
    sam3_model.frame_count = 1
    return state


def _result_from_outputs(
    outputs: dict[str, Any] | None,
    inference_frame: InferenceFrame,
    prompt: str,
    width: int,
    height: int,
) -> dict[str, Any]:
    outputs = outputs or {}
    boxes = _as_numpy(outputs.get("out_boxes_xywh"))
    masks = _as_numpy(outputs.get("out_binary_masks"))
    scores = _as_numpy(outputs.get("out_probs")).reshape(-1)
    object_ids = _as_numpy(outputs.get("out_obj_ids")).reshape(-1)
    if boxes.size == 0:
        boxes = np.empty((0, 4), dtype=np.float32)
    elif boxes.ndim == 1:
        boxes = boxes.reshape(-1, 4)
    if masks.size == 0:
        masks = np.empty((0,), dtype=np.float32)
    elif masks.ndim == 2:
        masks = masks[np.newaxis, ...]

    items: list[dict[str, Any]] = []
    count = min(len(boxes), len(scores), settings.SAM3_MAX_DETECTIONS)
    for index in range(count):
        score = float(scores[index])
        if score < settings.SAM3_SCORE_THRESHOLD:
            continue
        bbox = _normalised_xywh_box(boxes[index])
        if bbox is None:
            continue
        item: dict[str, Any] = {
            "class": prompt,
            "confidence": round(score, 2),
            "bbox": bbox,
            "bbox_format": "xyxy_normalized",
        }
        if index < len(object_ids):
            item["track_id"] = int(object_ids[index])
        if index < len(masks):
            polygon = _normalised_polygon(masks[index], width, height)
            if polygon is not None:
                item["mask"] = polygon
                item["mask_format"] = "polygon_normalized"
        items.append(item)

    return {
        "source": {
            "epoch": inference_frame.epoch,
            "seq": inference_frame.seq,
            "pts": inference_frame.pts,
            "time_base": inference_frame.time_base,
            "time": inference_frame.media_time,
            "timestamp_us": inference_frame.timestamp_us,
        },
        "width": width,
        "height": height,
        "items": items,
    }


def run_sam3(inference_frame: InferenceFrame, sam3_model: Sam3Model) -> dict:
    start = perf_counter()
    image_array = inference_frame.frame.to_ndarray(format="rgb24")
    height, width = image_array.shape[:2]
    image = Image.fromarray(image_array, mode="RGB")

    # The upstream predictor normally owns a process-wide BF16 context. The
    # service calls the underlying model methods directly so it can maintain a
    # growing live session; keep the dtype contract explicit at this boundary.
    with torch.inference_mode(), torch.autocast(
        device_type="cuda", dtype=torch.bfloat16
    ):
        if sam3_model.frame_count >= settings.SAM3_MAX_SESSION_FRAMES:
            reset_sam3(sam3_model)
        if sam3_model.session_id is not None:
            session = sam3_model.predictor._all_inference_states.get(
                sam3_model.session_id
            )
            if session is not None:
                sam3_model.predictor._extend_expiration_time(session)
        if sam3_model.inference_state is None:
            state = _start_session(sam3_model, image)
            _, outputs = sam3_model.predictor.model.add_prompt(
                state,
                frame_idx=0,
                text_str=sam3_model.prompt,
                output_prob_thresh=settings.SAM3_SCORE_THRESHOLD,
            )
        else:
            _append_frame(sam3_model, image)
            frame_idx = sam3_model.frame_count
            propagated = sam3_model.predictor.model.propagate_in_video(
                sam3_model.inference_state,
                start_frame_idx=frame_idx,
                max_frame_num_to_track=0,
                reverse=False,
                output_prob_thresh=settings.SAM3_SCORE_THRESHOLD,
            )
            try:
                _, outputs = next(propagated)
            except StopIteration:
                outputs = None
            sam3_model.frame_count += 1

    result = _result_from_outputs(outputs, inference_frame, sam3_model.prompt, width, height)
    result["inference_ms"] = round((perf_counter() - start) * 1000, 1)
    return result
