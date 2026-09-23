ARG VISION_DEPS_IMAGE=p4-vision-deps:local
FROM ${VISION_DEPS_IMAGE}

COPY . ./
COPY container-entrypoint.sh /usr/local/bin/p4-vision-entrypoint
# UniDepth's torch.compile path uses Triton JIT compilation on first inference.
# Keep the compiler install after uv sync so it doesn't invalidate dependency layers.
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc \
    && rm -rf /var/lib/apt/lists/*
ENV CC=/usr/bin/gcc

EXPOSE 39011
ENTRYPOINT ["/bin/sh", "/usr/local/bin/p4-vision-entrypoint"]
CMD ["python", "run.py", "--no-tls"]
