ARG VISION_DEPS_IMAGE=p4-vision-deps:local
FROM ${VISION_DEPS_IMAGE}

# TorchInductor needs a C/C++ toolchain at inference time when UniDepth's
# encode_decode graph is compiled. Keep it in this small app layer so the
# pinned CUDA/PyTorch dependency image does not need to be rebuilt.
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc g++ python3.12-dev \
    && rm -rf /var/lib/apt/lists/*

ENV CC=/usr/bin/gcc CXX=/usr/bin/g++

COPY . ./
COPY container-entrypoint.sh /usr/local/bin/p4-vision-entrypoint

EXPOSE 39011
ENTRYPOINT ["/bin/sh", "/usr/local/bin/p4-vision-entrypoint"]
CMD ["python", "run.py", "--no-tls"]
