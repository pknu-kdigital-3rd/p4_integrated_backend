"""Test the actual CUDA kernels independently of PyTorch's supported GPU list.

This helper is only for explicit native-kernel validation. It is not an
application fallback and does not change the locked PyTorch/CUDA environment.
"""

import ctypes as ct
import os

import numpy as np

from app.services.cuda_contour_runtime import ContourKernels, load_nvrtc
from app.services.gpu_contours import assemble_polygons


class NativeCudaRunner:
    def __init__(self, nvrtc_path, device=0):
        self.driver = ct.CDLL("nvcuda.dll" if os.name == "nt" else "libcuda.so.1")
        self.driver.cuInit.argtypes = [ct.c_uint]
        self.driver.cuDevicePrimaryCtxRetain.argtypes = [ct.POINTER(ct.c_void_p), ct.c_int]
        self.driver.cuCtxGetCurrent.argtypes = [ct.POINTER(ct.c_void_p)]
        self.driver.cuCtxSetCurrent.argtypes = [ct.c_void_p]
        self.driver.cuMemAlloc_v2.argtypes = [ct.POINTER(ct.c_uint64), ct.c_size_t]
        self.driver.cuMemFree_v2.argtypes = [ct.c_uint64]
        self.driver.cuMemcpyHtoD_v2.argtypes = [ct.c_uint64, ct.c_void_p, ct.c_size_t]
        self.driver.cuMemcpyDtoH_v2.argtypes = [ct.c_void_p, ct.c_uint64, ct.c_size_t]
        self.driver.cuModuleUnload.argtypes = [ct.c_void_p]
        self.device = device
        self.previous = ct.c_void_p()
        self.context = ct.c_void_p()
        self.check(self.driver.cuInit(0))
        self.check(self.driver.cuCtxGetCurrent(ct.byref(self.previous)))
        self.check(self.driver.cuDevicePrimaryCtxRetain(ct.byref(self.context), device))
        self.check(self.driver.cuCtxSetCurrent(self.context))
        self.kernels = ContourKernels(device, load_nvrtc(nvrtc_path))

    def check(self, error):
        if error:
            raise RuntimeError(f"native CUDA validation driver error: {error}")

    def close(self):
        self.check(self.driver.cuModuleUnload(self.kernels.module))
        self.check(self.driver.cuCtxSetCurrent(self.previous))
        release = getattr(self.driver, "cuDevicePrimaryCtxRelease_v2", None)
        if release is None:
            release = self.driver.cuDevicePrimaryCtxRelease
        release.argtypes = [ct.c_int]
        self.check(release(self.device))

    def trace(self, masks, orig_shape=None, max_points=4096, max_components=64):
        masks = np.ascontiguousarray(masks, dtype=np.uint8)
        count, height, width = masks.shape
        parents = np.empty((count, (height + 2) * (width + 2)), np.int32)
        counts = np.empty(count, np.int32)
        metadata = np.empty((count, max_components, 3), np.int32)
        points = np.empty((count, max_components, max_points, 2), np.int32)
        errors = np.empty(count, np.int32)
        arrays = [masks, parents, counts, metadata, points, errors]
        pointers = []
        try:
            for array in arrays:
                pointer = ct.c_uint64()
                self.check(self.driver.cuMemAlloc_v2(ct.byref(pointer), array.nbytes))
                pointers.append(pointer)
            self.check(self.driver.cuMemcpyHtoD_v2(pointers[0], masks.ctypes.data, masks.nbytes))
            self.kernels.run(*(pointer.value for pointer in pointers), count, height, width,
                             max_components, max_points, 0)
            self.check(self.driver.cuCtxSynchronize())
            for index in (2, 3, 4, 5):
                self.check(self.driver.cuMemcpyDtoH_v2(arrays[index].ctypes.data,
                                                     pointers[index], arrays[index].nbytes))
        finally:
            for pointer in pointers:
                self.check(self.driver.cuMemFree_v2(pointer))
        if np.any(errors):
            return errors, counts
        chunks = [points[n, slot, :metadata[n, slot, 1]]
                  for n in range(count) for slot in range(counts[n])]
        payload = np.concatenate(chunks) if chunks else np.empty((0, 2), np.int32)
        return assemble_polygons(metadata, counts, payload, (height, width),
                                 orig_shape or (height, width))
