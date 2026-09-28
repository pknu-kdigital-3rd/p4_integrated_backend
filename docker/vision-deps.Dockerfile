FROM nvidia/cuda:13.0.0-runtime-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive \
    UV_PROJECT_ENVIRONMENT=/opt/vision-venv \
    PATH=/opt/vision-venv/bin:$PATH \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3.12 python3.12-venv python3-pip ca-certificates git \
    && python3.12 -m pip install --break-system-packages --no-cache-dir uv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/services/vision
COPY pyproject.toml uv.lock ./
COPY --from=ultralytics . ./.ultralytics-custom/
RUN uv sync --frozen
# A PyPI xFormers wheel can install successfully while its C++/CUDA operators
# were built against another Torch/CUDA/Python combination. Fail before this
# expensive dependency image is tagged or pushed if its extension cannot load.
RUN /opt/vision-venv/bin/python -c "import sys, torch, xformers._cpp_lib as cpp; print('xFormers build check:', torch.__version__, torch.version.cuda); sys.exit(str(cpp._cpp_library_load_exception) if cpp._cpp_library_load_exception else 0)"
