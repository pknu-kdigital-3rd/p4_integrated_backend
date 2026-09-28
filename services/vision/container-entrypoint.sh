#!/bin/sh
set -eu

# Compose exposes every NVIDIA GPU (`count: all`). This script pins YOLO to one
# GPU and optionally exposes a second GPU for depth via UNIDEPTH_GPU_INDEX;
# inside Python, YOLO is cuda:0 and UniDepth is cuda:1.
#
# PCI_BUS_ID makes the indices used here match what nvidia-smi prints. CUDA's
# own default is FASTEST_FIRST, which renumbers devices by a speed heuristic -
# without this, "GPU 1" here and "GPU 1" on the host can be different cards, and
# "the last GPU" can mean the slowest one rather than the last slot.
export CUDA_DEVICE_ORDER="${CUDA_DEVICE_ORDER:-PCI_BUS_ID}"

# YOLO_GPU_INDEX pins one device by index; leave it unset to keep the
# YOLO_USE_LAST_GPU behavior. Indices are those of the devices visible to the
# container, which under Compose's `count: all` are the nvidia-smi indices.
gpu_index="${YOLO_GPU_INDEX:-}"
depth_gpu_index="${UNIDEPTH_GPU_INDEX:-}"

for value in "$gpu_index" "$depth_gpu_index"; do
    case "$value" in
        '' ) ;;
        *[!0-9]*)
            echo "p4-vision: GPU indices must be non-negative integers, got '$value'" >&2
            exit 1
            ;;
    esac
done

if [ -n "$depth_gpu_index" ] && [ "${YOLO_DEVICE:-cuda:0}" = "cpu" ]; then
    echo "p4-vision: YOLO_DEVICE=cpu overrides UNIDEPTH_GPU_INDEX=$depth_gpu_index; running both models on CPU" >&2
    depth_gpu_index=""
fi
if [ -n "$depth_gpu_index" ] && [ -z "$gpu_index" ] \
    && [ "${YOLO_USE_LAST_GPU:-true}" != "true" ]; then
    echo "p4-vision: set YOLO_GPU_INDEX or YOLO_USE_LAST_GPU=true with UNIDEPTH_GPU_INDEX" >&2
    exit 1
fi

if [ "${YOLO_DEVICE:-cuda:0}" = "cpu" ] && [ -n "$gpu_index" ]; then
    echo "p4-vision: YOLO_DEVICE=cpu overrides YOLO_GPU_INDEX=$gpu_index; running on the CPU" >&2
fi

# YOLO_DEVICE=cpu opts out of device selection altogether. So does
# YOLO_USE_LAST_GPU=false, which leaves every GPU visible and lets YOLO_DEVICE
# address one directly - now in nvidia-smi order.
if [ "${YOLO_DEVICE:-cuda:0}" != "cpu" ] \
    && { [ -n "$gpu_index" ] || [ -n "$depth_gpu_index" ] || [ "${YOLO_USE_LAST_GPU:-true}" = "true" ]; }; then
    if ! visible=$(python -c 'import torch; print(torch.cuda.device_count())'); then
        echo "p4-vision: GPU probe failed to run Python/PyTorch; see the error above. Check the image's /opt/vision-venv interpreter and dependencies." >&2
        exit 1
    fi
    case "$visible" in
        ''|*[!0-9]*)
            echo "p4-vision: GPU probe returned an invalid device count: '$visible'" >&2
            exit 1
            ;;
    esac
    if [ "$visible" -eq 0 ]; then
        # A pinned index cannot be honored without a CUDA runtime, so fail
        # rather than quietly running inference on the CPU at a fraction of
        # the speed the operator asked for.
        if [ -n "$gpu_index" ] || [ -n "$depth_gpu_index" ]; then
            echo "p4-vision: a GPU index was requested but no CUDA device is visible" >&2
            exit 1
        fi
        echo "p4-vision: no CUDA device is visible; falling back to CPU inference" >&2
        export YOLO_DEVICE=cpu
    else
        if [ -n "$gpu_index" ]; then
            if [ "$gpu_index" -ge "$visible" ]; then
                echo "p4-vision: YOLO_GPU_INDEX=$gpu_index is out of range; $visible GPU(s) visible (0..$((visible - 1)))" >&2
                exit 1
            fi
            selected="$gpu_index"
            reason="YOLO_GPU_INDEX"
        else
            selected=$((visible - 1))
            reason="YOLO_USE_LAST_GPU"
        fi
        if [ -n "$depth_gpu_index" ] && [ "$depth_gpu_index" -ge "$visible" ]; then
            echo "p4-vision: UNIDEPTH_GPU_INDEX=$depth_gpu_index is out of range; $visible GPU(s) visible (0..$((visible - 1)))" >&2
            exit 1
        fi
        # The selected YOLO device is always cuda:0 inside the process.
        case "${YOLO_DEVICE:-}" in
            ''|cuda:0) ;;
            *) echo "p4-vision: YOLO_DEVICE=$YOLO_DEVICE is ignored by GPU selection; use YOLO_GPU_INDEX to pin a device" >&2 ;;
        esac
        if [ -n "$depth_gpu_index" ] && [ "$depth_gpu_index" -ne "$selected" ]; then
            export CUDA_VISIBLE_DEVICES="$selected,$depth_gpu_index"
            export UNIDEPTH_DEVICE=cuda:1
            echo "p4-vision: YOLO on GPU $selected (cuda:0), UniDepth on GPU $depth_gpu_index (cuda:1)" >&2
        else
            export CUDA_VISIBLE_DEVICES="$selected"
            export UNIDEPTH_DEVICE=cuda:0
            echo "p4-vision: selected GPU $selected of $visible visible ($reason, CUDA_DEVICE_ORDER=$CUDA_DEVICE_ORDER)" >&2
        fi
        export YOLO_DEVICE=cuda:0
    fi
fi

exec "$@"
