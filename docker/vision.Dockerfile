ARG VISION_DEPS_IMAGE=p4-vision-deps:local
FROM ${VISION_DEPS_IMAGE}

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
# Check the copied interpreter and PyTorch without requiring a GPU at build time.
RUN /opt/vision-venv/bin/python -c "import sys, torch; print(sys.executable, torch.__version__)"
COPY --from=build /workspace/services/vision /workspace/services/vision
COPY --from=build /usr/local/bin/p4-vision-entrypoint /usr/local/bin/p4-vision-entrypoint

EXPOSE 39011
ENTRYPOINT ["/bin/sh", "/usr/local/bin/p4-vision-entrypoint"]
CMD ["python", "run.py", "--no-tls"]
