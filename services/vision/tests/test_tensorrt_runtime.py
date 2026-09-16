import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import torch

from app.services.tensorrt_runtime import (
    LetterboxMeta,
    TrackerDetections,
    classwise_nms,
    decode_segmentation_outputs,
    decode_segmentation_outputs_torch,
    letterbox_bgr,
    load_engine_manifest,
    prepare_tensor,
    resolve_manifest_path,
    unwrap_ultralytics_engine,
)


class TensorRTRuntimeHelperTests(unittest.TestCase):
    def test_unwraps_ultralytics_metadata_prefix(self):
        metadata = b'{"task":"segment","names":{"0":"person"}}'
        plan = b"ftrt\x01\x02\x03\x04"
        wrapped = len(metadata).to_bytes(4, "little") + metadata + plan

        self.assertEqual(unwrap_ultralytics_engine(wrapped), plan)
        self.assertEqual(unwrap_ultralytics_engine(plan), plan)

    def test_letterbox_preserves_aspect_ratio_and_records_padding(self):
        image = np.zeros((100, 200, 3), dtype=np.uint8)
        boxed, meta = letterbox_bgr(image, 640, 640)

        self.assertEqual(boxed.shape, (640, 640, 3))
        self.assertEqual(meta.resized_width, 640)
        self.assertEqual(meta.resized_height, 320)
        self.assertEqual(meta.pad_x, 0)
        self.assertEqual(meta.pad_y, 160)
        self.assertAlmostEqual(meta.scale, 3.2)

    def test_prepare_tensor_is_rgb_nchw_and_fp16(self):
        image = np.empty((4, 4, 3), dtype=np.uint8)
        image[:] = [10, 20, 30]  # BGR
        tensor, _meta = prepare_tensor(image, 4, 4)

        self.assertEqual(tensor.shape, (1, 3, 4, 4))
        self.assertEqual(tensor.dtype, np.float16)
        # The first channel is R after BGR -> RGB conversion.
        self.assertAlmostEqual(float(tensor[0, 0, 1, 1]), 30 / 255, places=3)
        self.assertTrue(tensor.flags.c_contiguous)

    def test_classwise_nms_suppresses_only_same_class_boxes(self):
        boxes = np.asarray(
            [
                [0, 0, 10, 10],
                [1, 1, 9, 9],
                [1, 1, 9, 9],
            ],
            dtype=np.float32,
        )
        scores = np.asarray([0.8, 0.7, 0.6], dtype=np.float32)
        class_ids = np.asarray([0, 0, 1], dtype=np.int64)

        kept = classwise_nms(boxes, scores, class_ids, 0.5, 300)

        self.assertEqual(kept.tolist(), [0, 2])

    def test_decoder_undoes_letterbox_and_emits_polygon_mask(self):
        # One class and one mask coefficient: 4 box + 1 class + 1 mask.
        manifest = {
            "schema_version": 1,
            "task": "segment",
            "names": {"0": "person"},
            "input": {"name": "images", "shape": [1, 3, 640, 640]},
            "outputs": {
                "pred": {"role": "predictions"},
                "proto": {"role": "prototypes"},
            },
            "postprocess": {
                "prediction_output": "pred",
                "prototype_output": "proto",
                "box_format": "xywh",
                "mask_dim": 1,
                "mask_offset": 5,
                "confidence_threshold": 0.1,
                "iou_threshold": 0.7,
                "mask_threshold": 0.5,
            },
        }
        meta = LetterboxMeta(
            original_width=200,
            original_height=100,
            target_width=640,
            target_height=640,
            resized_width=640,
            resized_height=320,
            scale=3.2,
            pad_x=0,
            pad_y=160,
        )
        prediction = np.asarray(
            [[[320.0], [320.0], [320.0], [192.0], [0.9], [10.0]]],
            dtype=np.float32,
        )
        prototype = np.full((1, 1, 4, 4), 10.0, dtype=np.float32)

        with patch(
            "app.services.tensorrt_runtime.settings.BBOX_FORMAT", "xyxy_normalized"
        ):
            detections = decode_segmentation_outputs(
                {"pred": prediction, "proto": prototype}, meta, manifest
            )

        self.assertEqual(len(detections), 1)
        self.assertEqual(detections[0]["class"], "person")
        self.assertAlmostEqual(detections[0]["confidence"], 0.9, places=6)
        self.assertEqual(detections[0]["bbox_format"], "xyxy_normalized")
        self.assertTrue(np.allclose(detections[0]["bbox"], [0.25, 0.2, 0.75, 0.8]))
        self.assertEqual(detections[0]["mask_format"], "polygon_normalized")
        self.assertGreaterEqual(len(detections[0]["mask"]), 3)

    def test_decoder_accepts_yolo26_end_to_end_topk_layout(self):
        manifest = {
            "schema_version": 1,
            "task": "segment",
            "names": {"0": "person", "1": "car"},
            "input": {"name": "images", "shape": [1, 3, 640, 640]},
            "outputs": {"pred": {}, "proto": {}},
            "postprocess": {
                "layout": "end2end",
                "prediction_output": "pred",
                "prototype_output": "proto",
                "box_format": "xyxy",
                "score_offset": 4,
                "class_offset": 5,
                "mask_offset": 6,
                "mask_dim": 1,
                "apply_nms": False,
                "confidence_threshold": 0.1,
            },
        }
        meta = LetterboxMeta(
            original_width=640,
            original_height=640,
            target_width=640,
            target_height=640,
            resized_width=640,
            resized_height=640,
            scale=1.0,
            pad_x=0,
            pad_y=0,
        )
        prediction = np.asarray(
            [
                [
                    [64.0, 96.0, 320.0, 480.0, 0.8, 1.0, 10.0],
                    [70.0, 100.0, 300.0, 470.0, 0.7, 1.0, 10.0],
                ]
            ],
            dtype=np.float32,
        )
        prototype = np.full((1, 1, 4, 4), 10.0, dtype=np.float32)

        with patch("app.services.tensorrt_runtime.settings.BBOX_FORMAT", "xyxy_pixels"):
            detections = decode_segmentation_outputs(
                {"pred": prediction, "proto": prototype}, meta, manifest
            )

        self.assertEqual(len(detections), 2)
        self.assertEqual(detections[0]["class"], "car")
        self.assertEqual(detections[0]["bbox"], [64.0, 96.0, 320.0, 480.0])
        self.assertAlmostEqual(detections[1]["confidence"], 0.7, places=6)

    def test_decoder_accepts_yolo26_end_to_end_channel_first_layout(self):
        manifest = {
            "schema_version": 1,
            "task": "segment",
            "names": {"0": "person"},
            "input": {"name": "images", "shape": [1, 3, 640, 640]},
            "outputs": {"pred": {}, "proto": {}},
            "postprocess": {
                "layout": "end2end",
                "prediction_output": "pred",
                "prototype_output": "proto",
                "box_format": "xyxy",
                "score_offset": 4,
                "class_offset": 5,
                "mask_offset": 6,
                "mask_dim": 1,
                "apply_nms": False,
                "confidence_threshold": 0.1,
            },
        }
        meta = LetterboxMeta(
            original_width=640,
            original_height=640,
            target_width=640,
            target_height=640,
            resized_width=640,
            resized_height=640,
            scale=1.0,
            pad_x=0,
            pad_y=0,
        )
        # [channels, top_k] after the batch dimension is removed.
        prediction = np.asarray(
            [[64.0], [96.0], [320.0], [480.0], [0.8], [0.0], [10.0]],
            dtype=np.float32,
        )
        prototype = np.full((1, 1, 4, 4), 10.0, dtype=np.float32)

        with patch("app.services.tensorrt_runtime.settings.BBOX_FORMAT", "xyxy_pixels"):
            detections = decode_segmentation_outputs(
                {"pred": prediction[None], "proto": prototype}, meta, manifest
            )

        self.assertEqual(len(detections), 1)
        self.assertEqual(detections[0]["class"], "person")
        self.assertEqual(detections[0]["bbox"], [64.0, 96.0, 320.0, 480.0])

    def test_torch_decoder_projects_masks_before_compact_host_copy(self):
        manifest = {
            "schema_version": 1,
            "task": "segment",
            "names": {"0": "person"},
            "input": {"name": "images", "shape": [1, 3, 64, 64]},
            "outputs": {"pred": {}, "proto": {}},
            "postprocess": {
                "layout": "end2end",
                "prediction_output": "pred",
                "prototype_output": "proto",
                "box_format": "xyxy",
                "score_offset": 4,
                "class_offset": 5,
                "mask_offset": 6,
                "mask_dim": 1,
                "apply_nms": False,
                "confidence_threshold": 0.5,
                "mask_contour_size": 32,
            },
        }
        meta = LetterboxMeta(
            original_width=64,
            original_height=64,
            target_width=64,
            target_height=64,
            resized_width=64,
            resized_height=64,
            scale=1.0,
            pad_x=0,
            pad_y=0,
        )
        outputs = {
            "pred": torch.tensor(
                [[[8.0, 8.0, 56.0, 56.0, 0.9, 0.0, 10.0]]],
                dtype=torch.float16,
            ),
            "proto": torch.full((1, 1, 4, 4), 10.0, dtype=torch.float16),
        }

        decoded = decode_segmentation_outputs_torch(outputs, meta, manifest, torch)

        self.assertIsNotNone(decoded)
        assert decoded is not None
        self.assertEqual(tuple(decoded.boxes_xyxy.shape), (1, 4))
        self.assertEqual(tuple(decoded.binary_masks.shape), (1, 32, 32))
        self.assertEqual(decoded.binary_masks.dtype, torch.uint8)
        self.assertGreater(int(decoded.binary_masks.sum().item()), 0)

    def test_tracker_adapter_supports_boolean_indexing(self):
        detections = TrackerDetections(
            xyxy=np.arange(8, dtype=np.float32).reshape(2, 4),
            xywh=np.arange(8, dtype=np.float32).reshape(2, 4),
            conf=np.asarray([0.2, 0.9], dtype=np.float32),
            cls=np.asarray([0, 1], dtype=np.float32),
        )
        selected = detections[detections.conf >= 0.5]
        self.assertEqual(len(selected), 1)
        self.assertEqual(selected.cls.tolist(), [1.0])

    def test_manifest_and_conventional_sidecar_resolution(self):
        engine = Path("model.engine")
        manifest_path = Path("model.engine.manifest.json")
        manifest_json = (
            '{"schema_version": 1, "task": "segment", '
            '"names": {"0": "person"}, '
            '"input": {"name": "images", "shape": [1, 3, 640, 640]}, '
            '"outputs": {"pred": {}, "proto": {}}, "postprocess": {}}'
        )
        with patch.object(Path, "exists", return_value=True), patch.object(
            Path, "read_text", return_value=manifest_json
        ):
            self.assertEqual(resolve_manifest_path(engine), manifest_path)
            self.assertEqual(load_engine_manifest(manifest_path)["task"], "segment")


if __name__ == "__main__":
    unittest.main()
