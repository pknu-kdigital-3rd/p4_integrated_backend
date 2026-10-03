"""Compile contour kernels with the NVRTC shipped with the locked CUDA Torch.

Uses the CUDA driver API directly, so there is no Torch C++ ABI dependency,
nvcc build toolchain, or additional Python/GPU package to install.
"""

import ctypes as ct
from functools import lru_cache
import os
from pathlib import Path
import sysconfig

import torch


SOURCE_DIR = Path(__file__).with_name("cuda")


def load_nvrtc(path: str | None = None):
    candidates = [Path(path)] if path else []
    if not path:
        torch_lib = Path(torch.__file__).parent / "lib"
        candidates.extend(sorted(torch_lib.glob("nvrtc64_*.dll")))
        candidates.extend(sorted(torch_lib.glob("libnvrtc.so*")))
        packages = Path(sysconfig.get_paths()["purelib"])
        candidates.extend(sorted(packages.glob("nvidia/*/lib/libnvrtc.so*")))
        candidates.append(Path("/usr/local/cuda/lib64/libnvrtc.so"))
    failures = []
    for candidate in candidates:
        if ".alt." in candidate.name or not candidate.is_file():
            continue
        try:
            library = ct.CDLL(str(candidate))
            if os.name == "nt":
                library._p4_dll_directory = os.add_dll_directory(str(candidate.parent))
            library.nvrtcVersion.argtypes = [ct.POINTER(ct.c_int), ct.POINTER(ct.c_int)]
            library.nvrtcGetErrorString.restype = ct.c_char_p
            return library
        except OSError as exc:
            failures.append(str(exc))
    raise RuntimeError("GPU contours require the NVRTC library shipped with CUDA PyTorch; "
                       "select YOLO_MASK_TRANSFER=packed if unavailable. " + "; ".join(failures))


def compile_ptx(nvrtc, architecture: int) -> bytes:
    source = (SOURCE_DIR / "contours.cu").read_bytes()
    headers = (ct.c_char_p * 2)(
        (SOURCE_DIR / "contour_trace.h").read_bytes(),
        b"typedef unsigned char uint8_t; typedef int int32_t; typedef long long int64_t;",
    )
    names = (ct.c_char_p * 2)(b"contour_trace.h", b"stdint.h")
    program = ct.c_void_p()
    nvrtc.nvrtcCreateProgram.argtypes = [ct.POINTER(ct.c_void_p), ct.c_char_p, ct.c_char_p,
                                       ct.c_int, ct.POINTER(ct.c_char_p), ct.POINTER(ct.c_char_p)]
    nvrtc.nvrtcCompileProgram.argtypes = [ct.c_void_p, ct.c_int, ct.POINTER(ct.c_char_p)]
    nvrtc.nvrtcGetProgramLogSize.argtypes = [ct.c_void_p, ct.POINTER(ct.c_size_t)]
    nvrtc.nvrtcGetProgramLog.argtypes = [ct.c_void_p, ct.c_void_p]
    nvrtc.nvrtcGetPTXSize.argtypes = [ct.c_void_p, ct.POINTER(ct.c_size_t)]
    nvrtc.nvrtcGetPTX.argtypes = [ct.c_void_p, ct.c_void_p]
    nvrtc.nvrtcDestroyProgram.argtypes = [ct.POINTER(ct.c_void_p)]
    error = nvrtc.nvrtcCreateProgram(ct.byref(program), source, b"p4_contours.cu", 2, headers, names)
    if error:
        raise RuntimeError(nvrtc.nvrtcGetErrorString(error).decode())
    try:
        options = (ct.c_char_p * 2)(b"--std=c++17", f"--gpu-architecture=compute_{architecture}".encode())
        error = nvrtc.nvrtcCompileProgram(program, 2, options)
        if error:
            size = ct.c_size_t()
            nvrtc.nvrtcGetProgramLogSize(program, ct.byref(size))
            log = ct.create_string_buffer(size.value)
            nvrtc.nvrtcGetProgramLog(program, log)
            raise RuntimeError("GPU contour CUDA compilation failed: " + log.value.decode())
        size = ct.c_size_t()
        error = nvrtc.nvrtcGetPTXSize(program, ct.byref(size))
        if error:
            raise RuntimeError(nvrtc.nvrtcGetErrorString(error).decode())
        ptx = ct.create_string_buffer(size.value)
        error = nvrtc.nvrtcGetPTX(program, ptx)
        if error:
            raise RuntimeError(nvrtc.nvrtcGetErrorString(error).decode())
        return ptx.raw
    finally:
        nvrtc.nvrtcDestroyProgram(ct.byref(program))


class ContourKernels:
    def __init__(self, device: int, nvrtc):
        self.driver = ct.CDLL("nvcuda.dll" if os.name == "nt" else "libcuda.so.1")
        self.driver.cuInit.argtypes = [ct.c_uint]
        self.driver.cuCtxGetDevice.argtypes = [ct.POINTER(ct.c_int)]
        self.driver.cuDeviceGetAttribute.argtypes = [ct.POINTER(ct.c_int), ct.c_int, ct.c_int]
        self.driver.cuModuleLoadData.argtypes = [ct.POINTER(ct.c_void_p), ct.c_void_p]
        self.driver.cuModuleGetFunction.argtypes = [ct.POINTER(ct.c_void_p), ct.c_void_p, ct.c_char_p]
        self.driver.cuLaunchKernel.argtypes = [ct.c_void_p] + [ct.c_uint] * 7 + [ct.c_void_p] * 3
        self.driver.cuGetErrorString.argtypes = [ct.c_int, ct.POINTER(ct.c_char_p)]
        self.check(self.driver.cuInit(0))
        ordinal = ct.c_int()
        # The caller has made the tensor's PyTorch context current. Query that
        # context rather than assuming host GPU numbering matches the tensor
        # ordinal after CUDA_VISIBLE_DEVICES remapping.
        self.check(self.driver.cuCtxGetDevice(ct.byref(ordinal)))
        major, minor = ct.c_int(), ct.c_int()
        self.check(self.driver.cuDeviceGetAttribute(ct.byref(major), 75, ordinal))
        self.check(self.driver.cuDeviceGetAttribute(ct.byref(minor), 76, ordinal))
        ptx = compile_ptx(nvrtc, major.value * 10 + minor.value)
        self.module = ct.c_void_p()
        self.check(self.driver.cuModuleLoadData(ct.byref(self.module), ct.c_char_p(ptx)))
        self.functions = {}
        for name in ("initialize_parents", "connect_pixels", "compress_parents", "trace_external_contours"):
            function = ct.c_void_p()
            self.check(self.driver.cuModuleGetFunction(ct.byref(function), self.module, name.encode()))
            self.functions[name] = function

    def check(self, error):
        if error:
            message = ct.c_char_p()
            self.driver.cuGetErrorString(error, ct.byref(message))
            raise RuntimeError(f"GPU contour CUDA driver error {error}: "
                               + (message.value.decode() if message.value else "unknown"))

    def launch(self, name, blocks, stream, pointers, integers):
        values = [ct.c_uint64(pointer) for pointer in pointers] + [ct.c_int(value) for value in integers]
        arguments = (ct.c_void_p * len(values))(*(ct.cast(ct.byref(value), ct.c_void_p) for value in values))
        self.check(self.driver.cuLaunchKernel(self.functions[name], blocks, 1, 1, 256, 1, 1,
                                             0, ct.c_void_p(stream), arguments, None))

    def run(self, masks, parents, counts, metadata, points, errors,
            count, height, width, components, max_points, stream):
        cells = (height + 2) * (width + 2)
        blocks = (cells * count + 255) // 256
        init_blocks = (max(cells * count, count * components * 3) + 255) // 256
        self.launch("initialize_parents", init_blocks, stream,
                    [parents, counts, errors, metadata], [cells, count, components])
        self.launch("connect_pixels", blocks, stream, [masks, parents], [height, width, count])
        self.launch("compress_parents", blocks, stream, [parents], [cells, count])
        self.launch("trace_external_contours", blocks, stream,
                    [masks, parents, counts, metadata, points, errors],
                    [height, width, count, components, max_points])


@lru_cache(maxsize=1)
def contour_kernels(device: int):
    nvrtc = load_nvrtc()
    major, minor = ct.c_int(), ct.c_int()
    error = nvrtc.nvrtcVersion(ct.byref(major), ct.byref(minor))
    if error:
        raise RuntimeError(nvrtc.nvrtcGetErrorString(error).decode())
    expected = int((torch.version.cuda or "0").split(".")[0])
    if major.value != expected:
        raise RuntimeError(f"GPU contour NVRTC {major.value}.{minor.value} "
                           f"does not match PyTorch CUDA {torch.version.cuda}")
    return ContourKernels(device, nvrtc)
