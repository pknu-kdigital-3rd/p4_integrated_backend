#!/usr/bin/env bash
# Copy the files Compose needs but Git does not provide from a running server
# checkout into a local checkout, so `docker compose -f <file> up` starts from
# a clean database and an empty MinIO.
#
# Usage:
#   scripts/pull-untracked-from-server.sh user@host /remote/p4_integrated_backend [local_checkout]
#
# Fetched (when present on the server):
#   .env, .env.*                       Compose secrets/overrides
#   node/.env*                         Node local env files
#   data/minio.license                 file bind mount; must exist before `up`
#   data/routing_state/                selected BIMS/playback source
#   data/vision_dataset/ (or SERVER_DATASET_DIR)  server video/GPS/IMU for Vision
#   services/vision/models/            YOLO .pt/.engine, UniDepth weights
#   services/vision/.ultralytics-custom/  custom Ultralytics fork (vision-deps build), source only
#   services/routing-tracking/*.graph_cache.pkl  optional; avoids slow graph rebuild
#   services/routing-tracking/data/busan_bus_live.csv, busan_bus_routes.json
#
# Excluded everywhere: .venv, __pycache__, *.pyc, .pytest_cache, *.egg-info, .git.
# Excluded from the fork: .worktrees, runs, checkpoints, weights, experiments.
# Never fetched: data/jwt and data/tls (private keys; p4-node and p4-nginx
# regenerate them on first start), secrets/, data/pgdata (PostgreSQL), data/minio_data (trip recordings),
# data/recording_spool, data/nginx_logs, data/map, build outputs.
set -euo pipefail

if [ $# -lt 2 ]; then
  sed -n '6,8p' "$0"
  exit 2
fi

REMOTE="$1"
REMOTE_DIR="$2"
LOCAL_DIR="${3:-$(cd "$(dirname "$0")/.." && pwd)}"

PATHS=(
  .env
  .env.*
  node/.env
  node/.env.*
  data/minio.license
  data/routing_state
  data/vision_dataset
  services/vision/models
  services/vision/.ultralytics-custom
  services/routing-tracking/*.graph_cache.pkl
  services/routing-tracking/data/busan_bus_live.csv
  services/routing-tracking/data/busan_bus_routes.json
)

FORK=services/vision/.ultralytics-custom
EXCLUDES=(
  .env.example .venv __pycache__ '*.pyc' .pytest_cache '*.egg-info' .git
  "$FORK/.worktrees" "$FORK/runs" "$FORK/checkpoints" "$FORK/weights" "$FORK/experiments"
)
exclude_args=""
for e in "${EXCLUDES[@]}"; do exclude_args+=" --exclude='$e'"; done

echo "==> Remote: ${REMOTE}:${REMOTE_DIR}"
echo "==> Local:  ${LOCAL_DIR}"
mkdir -p "$LOCAL_DIR"

# A SERVER_DATASET_DIR outside the checkout is fetched into data/vision_dataset.
remote_dataset="$(ssh "$REMOTE" "cd '$REMOTE_DIR' && [ -f .env ] && sed -n 's/^SERVER_DATASET_DIR=//p' .env | tail -n1 | tr -d '\r\"'" || true)"

# Expand globs remotely and keep only paths that exist, so tar never fails on
# an optional file. -h follows symlinks (.ultralytics-custom is one on dev
# hosts); unreadable files are skipped and reported by the checks below.
echo "==> Streaming files (tar over ssh)..."
ssh "$REMOTE" "cd '$REMOTE_DIR' && set -- && for p in ${PATHS[*]}; do [ -e \"\$p\" ] && set -- \"\$@\" \"\$p\"; done; \
  echo \"remote: \$# path(s)\" >&2; for p in \"\$@\"; do du -sh \"\$p\" >&2; done; \
  tar -czhf - --ignore-failed-read --warning=no-failed-read$exclude_args \"\$@\"" \
  | tar -xzf - -C "$LOCAL_DIR"

if [ -n "$remote_dataset" ] && [ "${remote_dataset#/}" != "$remote_dataset" ]; then
  echo "==> Fetching SERVER_DATASET_DIR=${remote_dataset} into data/vision_dataset"
  mkdir -p "$LOCAL_DIR/data/vision_dataset"
  ssh "$REMOTE" "tar -czf - -C '$remote_dataset' ." | tar -xzf - -C "$LOCAL_DIR/data/vision_dataset"
  if [ -f "$LOCAL_DIR/.env" ]; then
    sed -i 's|^SERVER_DATASET_DIR=.*|SERVER_DATASET_DIR=./data/vision_dataset|' "$LOCAL_DIR/.env"
    echo "    local .env: SERVER_DATASET_DIR=./data/vision_dataset"
  fi
fi

# Empty state directories for a clean first start.
for d in pgdata minio_data recording_spool nginx_logs routing_state jwt tls vision_dataset; do
  mkdir -p "$LOCAL_DIR/data/$d"
done

echo "==> Checks"
missing=0
check() { if [ -e "$LOCAL_DIR/$1" ]; then echo "  ok      $1"; else echo "  MISSING $1 ($2)"; missing=1; fi; }
check .env                                    "Compose secrets: NODE_INTERNAL_SERVICE_TOKEN, MINIO_*, LLM_PARENT_MONGO_URL"
check data/minio.license                      "required by p4-minio"
check services/routing-tracking/busan-roads_osm.pbf "tracked in git; run git lfs pull / checkout"
check services/vision/.ultralytics-custom/pyproject.toml "needed to build p4-vision-deps"
if ls "$LOCAL_DIR"/services/vision/models/a4_best.engine >/dev/null 2>&1; then
  echo "  ok      services/vision/models/a4_best.engine"
else
  echo "  note    a4_best.engine absent: export it from a4_best.pt on this GPU host (engines are GPU-specific)"
fi
[ -d "$LOCAL_DIR/data/pgdata" ] && [ -z "$(ls -A "$LOCAL_DIR/data/pgdata")" ] && echo "  ok      data/pgdata empty (fresh DB, migrate + seed on up)"
exit $missing
