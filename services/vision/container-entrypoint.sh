#!/bin/sh
set -eu

# Compose exposes every NVIDIA GPU (`count: all`) so one file works on hosts
# with any number of devices. This script pins the process to exactly one of
# them before Python imports torch; from inside the process that device is then
# the only visible one and is addressed as cuda:0.
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

case "$gpu_index" in
    '') ;;
    *[!0-9]*)
        echo "p4-vision: YOLO_GPU_INDEX must be a non-negative integer, got '$gpu_index'" >&2
        exit 1
        ;;
esac

if [ "${YOLO_DEVICE:-cuda:0}" = "cpu" ] && [ -n "$gpu_index" ]; then
    echo "p4-vision: YOLO_DEVICE=cpu overrides YOLO_GPU_INDEX=$gpu_index; running on the CPU" >&2
fi

# YOLO_DEVICE=cpu opts out of device selection altogether. So does
# YOLO_USE_LAST_GPU=false, which leaves every GPU visible and lets YOLO_DEVICE
# address one directly - now in nvidia-smi order.
if [ "${YOLO_DEVICE:-cuda:0}" != "cpu" ] \
    && { [ -n "$gpu_index" ] || [ "${YOLO_USE_LAST_GPU:-true}" = "true" ]; }; then
    visible=$(python -c 'import torch; print(torch.cuda.device_count())' 2>/dev/null || printf '0')
    case "$visible" in
        ''|*[!0-9]*) visible=0 ;;
    esac
    if [ "$visible" -eq 0 ]; then
        # A pinned index cannot be honored without a CUDA runtime, so fail
        # rather than quietly running inference on the CPU at a fraction of
        # the speed the operator asked for.
        if [ -n "$gpu_index" ]; then
            echo "p4-vision: YOLO_GPU_INDEX=$gpu_index was requested but no CUDA device is visible" >&2
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
        # Only one device stays visible, so cuda:0 is the sole valid value and
        # any other YOLO_DEVICE is about to be overwritten. Say so instead of
        # letting the stream run on a card the operator did not choose.
        case "${YOLO_DEVICE:-}" in
            ''|cuda:0) ;;
            *) echo "p4-vision: YOLO_DEVICE=$YOLO_DEVICE is ignored by GPU selection; use YOLO_GPU_INDEX to pin a device" >&2 ;;
        esac
        export CUDA_VISIBLE_DEVICES="$selected"
        export YOLO_DEVICE=cuda:0
        echo "p4-vision: selected GPU $selected of $visible visible ($reason, CUDA_DEVICE_ORDER=$CUDA_DEVICE_ORDER)" >&2
    fi
fi

exec "$@"
