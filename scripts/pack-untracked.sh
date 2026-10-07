#!/usr/bin/env bash
# Run ON THE SERVER. Packs the files Compose needs but Git does not provide into
# one zip, so a fresh checkout elsewhere can `docker compose -f <file> up` with a
# clean database and an empty MinIO.
#
# Usage (from an ssh session on the server):
#   bash scripts/pack-untracked.sh [repo_dir] [output.zip]
#   defaults: repo_dir = this script's checkout, output = ~/p4-untracked-<date>.zip
#
# Included (when present):
#   .env, .env.*, node/.env*          Compose secrets / overrides
#   data/minio.license                single-file bind mount; must exist before `up`
#   data/routing_state/               selected BIMS / playback source
#   data/vision_dataset/ (or SERVER_DATASET_DIR, stored as data/vision_dataset
#                                     and rewritten in the archived .env)
#   services/vision/models/           YOLO .pt/.engine, UniDepth weights
#   services/vision/.ultralytics-custom/  custom Ultralytics fork, source only
#   services/routing-tracking/*.graph_cache.pkl  optional; avoids slow graph rebuild
#   services/routing-tracking/data/busan_bus_live.csv, busan_bus_routes.json
#
# Excluded everywhere: .venv, __pycache__, *.pyc, .pytest_cache, *.egg-info, .git.
# Excluded from the fork: .worktrees, runs, checkpoints, weights, experiments.
# Never included: data/jwt and data/tls (private keys; p4-node and p4-nginx
# regenerate them on first start), secrets/, data/pgdata (PostgreSQL),
# data/minio_data (trip recordings), data/recording_spool, data/nginx_logs,
# data/map, build outputs. Symlinks are followed; unreadable files are skipped
# and listed.
set -euo pipefail

REPO_DIR="$(cd "${1:-$(dirname "$0")/..}" && pwd)"
OUT="${2:-$HOME/p4-untracked-$(date +%Y%m%d-%H%M).zip}"

if ! command -v python3 >/dev/null 2>&1; then
  OUT="${OUT%.zip}.tar.gz"
  echo "python3 not found; writing ${OUT} instead"
  cd "$REPO_DIR"
  set --
  for p in .env .env.* node/.env node/.env.* data/minio.license data/routing_state \
           data/vision_dataset services/vision/models services/vision/.ultralytics-custom \
           services/routing-tracking/*.graph_cache.pkl \
           services/routing-tracking/data/busan_bus_live.csv \
           services/routing-tracking/data/busan_bus_routes.json; do
    [ -e "$p" ] && set -- "$@" "$p"
  done
  f=services/vision/.ultralytics-custom
  tar -czhf "$OUT" --ignore-failed-read --warning=no-failed-read \
    --exclude=.env.example --exclude=.venv --exclude=__pycache__ --exclude='*.pyc' \
    --exclude=.pytest_cache --exclude='*.egg-info' --exclude=.git \
    --exclude="$f/.worktrees" --exclude="$f/runs" --exclude="$f/checkpoints" \
    --exclude="$f/weights" --exclude="$f/experiments" "$@"
  echo "SERVER_DATASET_DIR outside the checkout is not included in the tar fallback."
  ls -lh "$OUT"
  exit 0
fi

python3 - "$REPO_DIR" "$OUT" <<'PY'
import glob, os, re, sys, zipfile

repo, out = sys.argv[1], os.path.abspath(sys.argv[2])
FORK = "services/vision/.ultralytics-custom"
PATHS = [
    ".env", ".env.*", "node/.env", "node/.env.*",
    "data/minio.license", "data/routing_state", "data/vision_dataset",
    "services/vision/models", FORK,
    "services/routing-tracking/*.graph_cache.pkl",
    "services/routing-tracking/data/busan_bus_live.csv",
    "services/routing-tracking/data/busan_bus_routes.json",
]
SKIP_DIRS = {".venv", "__pycache__", ".pytest_cache", ".git"}
SKIP_PREFIXES = tuple(f"{FORK}/{d}" for d in
                      (".worktrees", "runs", "checkpoints", "weights", "experiments"))

def skipped(arc):
    parts = arc.split("/")
    if any(p in SKIP_DIRS or p.endswith(".egg-info") for p in parts):
        return True
    if parts[-1] == ".env.example" or parts[-1].endswith(".pyc"):
        return True
    return any(arc == p or arc.startswith(p + "/") for p in SKIP_PREFIXES)

# A SERVER_DATASET_DIR outside the checkout is archived as data/vision_dataset.
env_path = os.path.join(repo, ".env")
dataset = None
env_text = None
if os.path.isfile(env_path) and os.access(env_path, os.R_OK):
    with open(env_path, encoding="utf-8", newline="") as f:
        env_text = f.read()
    m = re.findall(r"(?m)^SERVER_DATASET_DIR=(.*)$", env_text)
    value = m[-1].strip().strip("\"'") if m else ""
    if value.startswith("/"):
        dataset = value
        env_text = re.sub(r"(?m)^SERVER_DATASET_DIR=.*$",
                          "SERVER_DATASET_DIR=./data/vision_dataset", env_text)

sources = []  # (filesystem path, archive path)
for pattern in PATHS:
    for match in sorted(glob.glob(os.path.join(repo, pattern))):
        sources.append((match, os.path.relpath(match, repo).replace(os.sep, "/")))
if dataset and os.path.isdir(dataset):
    sources = [s for s in sources if s[1] != "data/vision_dataset"]
    sources.append((dataset, "data/vision_dataset"))

unreadable, total, count = [], 0, 0
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
    def add_file(path, arc):
        global total, count
        if skipped(arc):
            return
        if arc == ".env" and env_text is not None:
            zf.writestr(".env", env_text)
            count += 1
            return
        try:
            zf.write(path, arc)
            total += os.path.getsize(path)
            count += 1
        except OSError as e:
            unreadable.append(f"{arc} ({e.strerror})")

    for src, arc in sources:
        if skipped(arc):
            continue
        if os.path.isfile(src):
            add_file(src, arc)
            print(f"  + {arc}")
            continue
        print(f"  + {arc}/")
        for root, dirs, files in os.walk(src, followlinks=True,
                                         onerror=lambda e: unreadable.append(f"{e.filename} ({e.strerror})")):
            rel_root = os.path.relpath(root, src).replace(os.sep, "/")
            base = arc if rel_root == "." else f"{arc}/{rel_root}"
            dirs[:] = [d for d in dirs if not skipped(f"{base}/{d}")]
            for name in files:
                add_file(os.path.join(root, name), f"{base}/{name}")

if dataset:
    print(f"SERVER_DATASET_DIR={dataset} stored as data/vision_dataset (archived .env rewritten)")
for item in unreadable:
    print(f"  skipped (unreadable): {item}")
print(f"{count} files, {total / 2**20:.1f} MiB uncompressed -> {out} "
      f"({os.path.getsize(out) / 2**20:.1f} MiB)")
PY

cat <<EOF

Download and unpack on Windows (PowerShell):
  scp $(whoami)@$(hostname -I 2>/dev/null | awk '{print $1}'):$OUT .
  tar -xf $(basename "$OUT") -C E:\\project4\\p4_integrated_backend
EOF
