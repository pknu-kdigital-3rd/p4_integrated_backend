ARG VISION_DEPS_IMAGE=p4-vision-deps:local
FROM ${VISION_DEPS_IMAGE}

COPY . ./
COPY container-entrypoint.sh /usr/local/bin/p4-vision-entrypoint

EXPOSE 39011
ENTRYPOINT ["/bin/sh", "/usr/local/bin/p4-vision-entrypoint"]
CMD ["python", "run.py", "--no-tls"]
