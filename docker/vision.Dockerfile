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
COPY . ./
COPY container-entrypoint.sh /usr/local/bin/p4-vision-entrypoint

EXPOSE 39011
ENTRYPOINT ["/bin/sh", "/usr/local/bin/p4-vision-entrypoint"]
CMD ["python", "run.py", "--no-tls"]
