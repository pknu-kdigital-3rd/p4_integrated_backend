FROM python:3.12-slim-bookworm

# ITS fleet assistant API (services/llm). Settings and credentials come from
# the Compose environment (KINDEX_* / KSERVE_*), never from the image.
WORKDIR /workspace/services/llm
ENV UV_PROJECT_ENVIRONMENT=/opt/llm-venv \
    PATH=/opt/llm-venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    FASTEMBED_CACHE_PATH=/var/cache/p4-llm/fastembed

RUN pip install --no-cache-dir uv
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
COPY . ./

EXPOSE 18080
CMD ["uvicorn", "serve.api:app", "--app-dir", "src", "--host", "0.0.0.0", "--port", "18080"]
