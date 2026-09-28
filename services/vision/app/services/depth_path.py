"""Depth-only adapter for the source revision pinned in depth.py.

Reuse UniDepth's geometry helpers rather than approximating camera calibration.
Only the most recent geometry is retained; this object has one worker owner.
"""
from typing import Any

import numpy as np


class DepthOnlyPath:
    def __init__(self, model: Any, torch: Any) -> None:
        self.model = model
        self.torch = torch
        self.geometry_key = None
        self.forward = self.eager_forward

    def eager_forward(self, image: Any, rays: Any) -> Any:
        # A tensor-only boundary lets Inductor prune unused model outputs.
        return self.model.encode_decode(
            {"image": image, "rays": rays}, image_metas=[]
        )[1]["depth"]

    def __call__(self, rgb: Any, intrinsic: np.ndarray) -> Any:
        from unidepth.models.unidepthv2.unidepthv2 import (
            get_paddings, get_resize_factor, _postprocess,
        )
        from unidepth.utils.camera import BatchCamera, Pinhole
        from unidepth.utils.constants import IMAGENET_DATASET_MEAN, IMAGENET_DATASET_STD
        from torchvision.transforms.v2.functional import normalize
        from torch.nn import functional as F

        height, width = rgb.shape[-2:]
        level = self.model.resolution_level
        key = (height, width, level, intrinsic.tobytes())
        if key != self.geometry_key:
            constraints = self.model.shape_constraints
            self.padding, self.padded_shape = get_paddings(
                (height, width), constraints["ratio_bounds"]
            )
            step = (constraints["pixels_max"] - constraints["pixels_min"]) / 10
            low = constraints["pixels_min"] + level * step
            factor, self.network_shape = get_resize_factor(
                self.padded_shape, (low, constraints["pixels_min"] + (level + 1) * step)
            )
            camera = BatchCamera.from_camera(Pinhole(
                K=self.torch.as_tensor(intrinsic.copy(), device=rgb.device)
            )).to(rgb.device)
            left, right, top, bottom = self.padding
            camera = camera.crop(left=-left, top=-top, right=-right, bottom=-bottom)
            camera = camera.resize(factor)
            self.rays = camera.get_rays(shapes=(1, *self.network_shape))
            self.geometry_key = key

        image = normalize(
            rgb.unsqueeze(0).float() / 255,
            mean=IMAGENET_DATASET_MEAN, std=IMAGENET_DATASET_STD,
        )
        image = F.interpolate(
            F.pad(image, self.padding), size=self.network_shape,
            mode="bilinear", align_corners=False,
        )
        depth = self.forward(image, self.rays)
        return _postprocess(
            depth, self.padded_shape, self.padding,
            interpolation_mode=self.model.interpolation_mode,
        )
