FROM nvidia/cuda:13.0.0-devel-ubuntu24.04 AS build

ENV DEBIAN_FRONTEND=noninteractive \
    UV_PROJECT_ENVIRONMENT=/opt/vision-venv \
    PATH=/opt/vision-venv/bin:$PATH \
    PYTHONUNBUFFERED=1

ARG TORCH_CUDA_ARCH_LIST=8.9

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        git \
        g++ \
        gcc \
        ninja-build \
        python3.12 \
        python3.12-dev \
        python3.12-venv \
        python3-pip \
    && python3.12 -m pip install --break-system-packages --no-cache-dir uv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/services/vision
COPY pyproject.toml uv.lock ./
COPY --from=ultralytics . ./.ultralytics-custom/
RUN uv sync --frozen

# Build xFormers against the exact Python and PyTorch already installed above.
# The default architecture targets the deployment RTX 6000 Ada; override this
# build argument when building an image for a different GPU architecture.
RUN uv pip install --python /opt/vision-venv/bin/python setuptools wheel \
    && git clone --depth 1 --recurse-submodules --branch v0.0.35 \
       https://github.com/facebookresearch/xformers.git /tmp/xformers-src \
    && MAX_JOBS=2 TORCH_CUDA_ARCH_LIST=${TORCH_CUDA_ARCH_LIST} FORCE_CUDA=1 XFORMERS_BUILD_TYPE=Release \
       BUILD_VERSION=0.0.35 \
       uv pip install --python /opt/vision-venv/bin/python \
         --no-build-isolation --no-deps --reinstall \
         /tmp/xformers-src \
    && python -m xformers.info \
    && rm -rf /tmp/xformers-src

COPY . ./
COPY container-entrypoint.sh /usr/local/bin/p4-vision-entrypoint

FROM nvidia/cuda:13.0.0-runtime-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive \
    UV_PROJECT_ENVIRONMENT=/opt/vision-venv \
    PATH=/opt/vision-venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    CC=/usr/bin/gcc

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        gcc \
        python3.12 \
        python3.12-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/services/vision
COPY --from=build /opt/vision-venv /opt/vision-venv
COPY --from=build /workspace/services/vision /workspace/services/vision
COPY --from=build /usr/local/bin/p4-vision-entrypoint /usr/local/bin/p4-vision-entrypoint

EXPOSE 39011
ENTRYPOINT ["/bin/sh", "/usr/local/bin/p4-vision-entrypoint"]
CMD ["python", "run.py", "--no-tls"]
