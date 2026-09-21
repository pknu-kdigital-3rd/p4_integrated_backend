FROM python:3.12-slim-bookworm

WORKDIR /workspace/services/routing-tracking
ENV UV_PROJECT_ENVIRONMENT=/opt/routing-venv \
    PATH=/opt/routing-venv/bin:$PATH \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir uv
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --extra osmnx
COPY . ./

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
