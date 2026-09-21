#!/bin/sh
set -eu

# Compose exposes all NVIDIA GPUs so the same file works on hosts with any
# number of devices. Select the last visible device before Python imports
# torch; inside the process it becomes cuda:0.
if [ "${YOLO_USE_LAST_GPU:-true}" = "true" ] \
  && [ "${YOLO_DEVICE:-cuda:0}" != "cpu" ]; then
  gpu_count=$(python -c 'import torch; print(torch.cuda.device_count())' 2>/dev/null || printf '0')
  case "$gpu_count" in
    ''|*[!0-9]*) gpu_count=0 ;;
  esac
  if [ "$gpu_count" -gt 0 ]; then
    export CUDA_VISIBLE_DEVICES=$((gpu_count - 1))
    export YOLO_DEVICE=cuda:0
  else
    export YOLO_DEVICE=cpu
  fi
fi

exec "$@"
