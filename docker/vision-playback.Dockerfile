FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    UV_PROJECT_ENVIRONMENT=/opt/vision-venv \
    PATH=/opt/vision-venv/bin:$PATH \
    VISION_SOURCE=server \
    VISION_INFERENCE_MODE=cached

RUN pip install --no-cache-dir uv==0.11.19
WORKDIR /workspace/services/vision
COPY pyproject.toml uv.lock ./
# The frozen base dependency graph excludes all inference packages and the
# custom Ultralytics checkout. PyAV's wheel supplies the CPU video codecs.
RUN uv sync --frozen --no-default-groups --no-dev
COPY . ./
EXPOSE 39011
CMD ["python", "run.py", "--no-tls"]
