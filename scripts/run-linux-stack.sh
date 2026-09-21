#!/usr/bin/env bash
set -Eeuo pipefail

# Compose is the only process supervisor for the Linux stack.  The wrapper
# keeps the existing command names while making service ports private to the
# Compose network and generating a safe runtime env file from deploy/env.local.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${P4_ENV_FILE:-${PROJECT_ROOT}/deploy/env.local}"
RUNTIME_DIR="${P4_RUNTIME_DIR:-${PROJECT_ROOT}/.runtime}"
COMPOSE_ENV_FILE="${RUNTIME_DIR}/compose.env"
TLS_DIR="${PROJECT_ROOT}/secrets/tls"

# The Node image forwards an SSH agent to npm for its private Git dependency;
# keep BuildKit enabled for every Compose build, including older Docker hosts.
export DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-1}"

log() { printf '[p4-stack] %s\n' "$*"; }
die() { printf '[p4-stack] ERROR: %s\n' "$*" >&2; exit 1; }
require_command() { command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"; }

require_buildkit_ssh_agent() {
  [[ -n "${SSH_AUTH_SOCK:-}" ]] \
    || die "SSH_AUTH_SOCK is required to build the Node image; start an SSH agent with access to the private Git dependency"
  ssh-add -L >/dev/null 2>&1 \
    || die "The SSH agent has no usable key; add the private Git dependency key before building"
}

load_environment() {
  [[ -f "$ENV_FILE" ]] || die "Missing $ENV_FILE. Copy deploy/env.local.example to deploy/env.local and edit it."
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a

  P4_ROOT="${P4_ROOT:-$PROJECT_ROOT}"
  TLS_PUBLIC_ADDRESS="${TLS_PUBLIC_ADDRESS:-10.174.96.119}"
  NODE_ENV="${NODE_ENV:-production}"
  RECORDING_ENABLED="${RECORDING_ENABLED:-false}"
  ANDROID_TELEMETRY_ENABLED="${ANDROID_TELEMETRY_ENABLED:-false}"
  PUBLIC_OPERATOR_URL="${PUBLIC_OPERATOR_URL:-https://${TLS_PUBLIC_ADDRESS}:39001}"
  VISION_PUBLIC_BASE_URL="${VISION_PUBLIC_BASE_URL:-https://${TLS_PUBLIC_ADDRESS}:39002}"
  LIVE_VIEW_URL="${LIVE_VIEW_URL:-${VISION_PUBLIC_BASE_URL}/}"
  DATABASE_URL="${DATABASE_URL:-postgresql://app:app@db:5432/vehicle_platform?schema=public}"
  POSTGRES_USER="${POSTGRES_USER:-app}"
  POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-app}"
  POSTGRES_DB="${POSTGRES_DB:-vehicle_platform}"
  MINIO_RECORDING_BUCKET="${MINIO_RECORDING_BUCKET:-p4-trip-recordings}"
  MINIO_PUBLIC_ENDPOINT="${MINIO_PUBLIC_ENDPOINT:-https://${TLS_PUBLIC_ADDRESS}:39003}"
  MINIO_BROWSER_REDIRECT_URL="${MINIO_BROWSER_REDIRECT_URL:-http://127.0.0.1:9001}"
  TURN_URL="${TURN_URL:-turn:${TLS_PUBLIC_ADDRESS}:39004?transport=udp}"
  NODE_SOURCE_PATH="${NODE_SOURCE_PATH:-${PROJECT_ROOT}/node}"
  OPERATOR_WEB_SOURCE_PATH="${OPERATOR_WEB_SOURCE_PATH:-${PROJECT_ROOT}/operator-web}"
  ROUTING_SOURCE_PATH="${ROUTING_SOURCE_PATH:-${PROJECT_ROOT}/services/routing-tracking}"
  VISION_SOURCE_PATH="${VISION_SOURCE_PATH:-${PROJECT_ROOT}/services/vision}"
  VISION_MODEL_HOST_PATH="${VISION_MODEL_HOST_PATH:-${PROJECT_ROOT}/services/vision/models}"
  VISION_ULTRALYTICS_HOST_PATH="${VISION_ULTRALYTICS_HOST_PATH:-${PROJECT_ROOT}/services/vision/.ultralytics-custom}"
  VISION_ULTRALYTICS_CONTEXT="${VISION_ULTRALYTICS_CONTEXT:-$VISION_ULTRALYTICS_HOST_PATH}"
  YOLO_DEVICE_CONTAINER="${YOLO_DEVICE_CONTAINER:-cuda:0}"

  [[ "$RECORDING_ENABLED" == true || "$RECORDING_ENABLED" == false ]] || die "RECORDING_ENABLED must be true or false"
  [[ "$ANDROID_TELEMETRY_ENABLED" == true || "$ANDROID_TELEMETRY_ENABLED" == false ]] || die "ANDROID_TELEMETRY_ENABLED must be true or false"
  [[ "$(cd -- "$P4_ROOT" 2>/dev/null && pwd)" == "$PROJECT_ROOT" ]] || die "P4_ROOT must point to this checkout: $PROJECT_ROOT"
  [[ -n "${JWT_ISSUER:-}" && -n "${JWT_AUDIENCE:-}" && -n "${JWT_KEY_ID:-}" ]] || die "JWT_ISSUER, JWT_AUDIENCE, and JWT_KEY_ID are required"

  if [[ "$RECORDING_ENABLED" == true || "$ANDROID_TELEMETRY_ENABLED" == true ]]; then
    local internal_token="${NODE_INTERNAL_SERVICE_TOKEN:-}"
    [[ ${#internal_token} -ge 32 && "$internal_token" != replace-* ]] \
      || die "NODE_INTERNAL_SERVICE_TOKEN must be a real token of at least 32 characters"
  fi
  if [[ "$RECORDING_ENABLED" == true ]]; then
    local variable
    for variable in MINIO_ROOT_USER MINIO_ROOT_PASSWORD MINIO_ACCESS_KEY MINIO_SECRET_KEY MINIO_NODE_ACCESS_KEY MINIO_NODE_SECRET_KEY MINIO_PUBLIC_ENDPOINT; do
      [[ -n "${!variable:-}" ]] || die "$variable is required when RECORDING_ENABLED=true"
    done
    [[ "$MINIO_PUBLIC_ENDPOINT" == https://* ]] || die "MINIO_PUBLIC_ENDPOINT must use HTTPS"
  fi
  export P4_ROOT TLS_PUBLIC_ADDRESS NODE_ENV RECORDING_ENABLED ANDROID_TELEMETRY_ENABLED
  export PUBLIC_OPERATOR_URL VISION_PUBLIC_BASE_URL LIVE_VIEW_URL DATABASE_URL
  export POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB MINIO_RECORDING_BUCKET
  export MINIO_PUBLIC_ENDPOINT MINIO_BROWSER_REDIRECT_URL TURN_URL
  export NODE_SOURCE_PATH OPERATOR_WEB_SOURCE_PATH ROUTING_SOURCE_PATH VISION_SOURCE_PATH
  export VISION_MODEL_HOST_PATH VISION_ULTRALYTICS_HOST_PATH VISION_ULTRALYTICS_CONTEXT YOLO_DEVICE_CONTAINER
}

compose_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

write_compose_env() {
  mkdir -p "$RUNTIME_DIR"
  local name
  # Compose env_file syntax is deliberately generated from the already
  # sourced shell environment; deploy/env.local remains shell-compatible and
  # never needs to be passed directly to Docker Compose.
  {
    for name in \
      NODE_ENV DATABASE_URL JWT_PRIVATE_KEY_PATH JWT_PUBLIC_KEY_PATH JWT_ISSUER JWT_AUDIENCE JWT_ACCESS_TOKEN_TTL JWT_KEY_ID \
      PUBLIC_OPERATOR_URL VISION_PUBLIC_BASE_URL LIVE_VIEW_URL ROUTING_TRACKING_SERVICE_TOKEN ROUTING_GRAPH_BACKEND \
      OPERATOR_DEMO_PUBLIC TRUST_PROXY RECORDING_ENABLED RECORDING_VALIDATE_TRIP_CONTEXT ANDROID_TELEMETRY_ENABLED \
      NODE_INTERNAL_SERVICE_TOKEN RECORDING_SEGMENT_SECONDS RECORDING_QUEUE_FRAMES RECORDING_UPLOAD_QUEUE RECORDING_SPOOL_DIR RECORDING_SPOOL_MAX_BYTES \
      RECORDING_DETECTION_QUEUE_SIZE RECORDING_DETECTION_SAMPLE_EVERY_N_FRAMES MINIO_ENDPOINT MINIO_USE_SSL MINIO_RECORDING_BUCKET \
      MINIO_ACCESS_KEY MINIO_SECRET_KEY MINIO_NODE_ACCESS_KEY MINIO_NODE_SECRET_KEY MINIO_PUBLIC_ENDPOINT MINIO_BROWSER_REDIRECT_URL \
      MINIO_ROOT_USER MINIO_ROOT_PASSWORD YOLO_MODEL YOLO_DEVICE YOLO_HALF YOLO_RETINA_MASKS YOLO_MAX_DETECTIONS \
      YOLO_MASK_CONTOUR_SIZE YOLO_MASK_POLYGON_SIMPLIFY YOLO_MASK_POLYGON_EPSILON_RATIO YOLO_FRAME_DROP_POLICY \
      YOLO_INFERENCE_QUEUE_SIZE METRICS_LOG_INTERVAL_SECONDS ENABLE_PYTHON_ALLOC_PROFILE FORWARDED_ALLOW_IPS \
      TURN_URL TURN_USERNAME TURN_PASSWORD TURN_REALM TURN_LISTENING_IP TURN_RELAY_IP TURN_EXTERNAL_IP \
      PY_ANDROID_LIVE_URL PY_TELEMETRY_URL MEDIA_RELAY_INTERNAL_BASE_URL LIVE_VIEW_PARENT_ORIGINS \
      TELEMETRY_NODE_QUEUE TELEMETRY_VISION_QUEUE TELEMETRY_CURRENT_MAX_AGE_SECONDS ROUTING_EDGE_INDEX_BUCKET_DEGREES; do
      if [[ -v "$name" ]]; then
        printf '%s=%s\n' "$name" "$(compose_escape "${!name}")"
      fi
    done
    printf 'P4_ROOT=%s\n' "$(compose_escape "$P4_ROOT")"
    printf 'TLS_PUBLIC_ADDRESS=%s\n' "$(compose_escape "$TLS_PUBLIC_ADDRESS")"
    printf 'NODE_SOURCE_PATH=%s\n' "$(compose_escape "$NODE_SOURCE_PATH")"
    printf 'OPERATOR_WEB_SOURCE_PATH=%s\n' "$(compose_escape "$OPERATOR_WEB_SOURCE_PATH")"
    printf 'ROUTING_SOURCE_PATH=%s\n' "$(compose_escape "$ROUTING_SOURCE_PATH")"
    printf 'VISION_SOURCE_PATH=%s\n' "$(compose_escape "$VISION_SOURCE_PATH")"
    printf 'VISION_MODEL_HOST_PATH=%s\n' "$(compose_escape "$VISION_MODEL_HOST_PATH")"
    printf 'VISION_ULTRALYTICS_HOST_PATH=%s\n' "$(compose_escape "$VISION_ULTRALYTICS_HOST_PATH")"
    printf 'VISION_ULTRALYTICS_CONTEXT=%s\n' "$(compose_escape "$VISION_ULTRALYTICS_CONTEXT")"
    printf 'YOLO_DEVICE_CONTAINER=%s\n' "$(compose_escape "$YOLO_DEVICE_CONTAINER")"
  } >"$COMPOSE_ENV_FILE"
  chmod 600 "$COMPOSE_ENV_FILE"
}

compose_files() {
  printf '%s\n' -f "${PROJECT_ROOT}/docker-compose.yml"
  [[ "${P4_COMPOSE_DEV:-false}" == true ]] && printf '%s\n' -f "${PROJECT_ROOT}/docker-compose.dev.yml"
  [[ "$RECORDING_ENABLED" == true ]] && printf '%s\n' -f "${PROJECT_ROOT}/docker-compose.recording.yml"
}

compose() {
  local args=()
  while IFS= read -r item; do args+=("$item"); done < <(compose_files)
  docker compose --env-file "$COMPOSE_ENV_FILE" "${args[@]}" "$@"
}

generate_jwt_keys() {
  local jwt_dir="${PROJECT_ROOT}/secrets/jwt"
  mkdir -p "$jwt_dir"
  if [[ ! -f "${jwt_dir}/private.pem" ]]; then
    log "Generating JWT private key"
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "${jwt_dir}/private.pem"
    chmod 600 "${jwt_dir}/private.pem"
  fi
  if [[ ! -f "${jwt_dir}/public.pem" ]]; then
    log "Generating JWT public key"
    openssl rsa -pubout -in "${jwt_dir}/private.pem" -out "${jwt_dir}/public.pem"
  fi
}

generate_tls_certificate() {
  local ca_key="${TLS_DIR}/development-ca.key"
  local ca_cert="${TLS_DIR}/development-ca.crt"
  local server_key="${TLS_DIR}/server.key"
  local server_csr="${TLS_DIR}/server.csr"
  local server_cert="${TLS_DIR}/server.crt"
  local serial_file="${TLS_DIR}/development-ca.srl"
  mkdir -p "$TLS_DIR"
  if [[ -e "$ca_key" && -e "$ca_cert" && -e "$server_key" && -e "$server_cert" ]]; then
    return 0
  fi
  [[ ! -e "$ca_key" && ! -e "$ca_cert" && ! -e "$server_key" && ! -e "$server_cert" ]] \
    || die "TLS directory is incomplete; repair ${TLS_DIR} before continuing"
  log "Generating development CA and TLS certificate for ${TLS_PUBLIC_ADDRESS}"
  export ITS_TLS_SAN="IP:${TLS_PUBLIC_ADDRESS}"
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$ca_key"
  openssl req -x509 -new -sha256 -days 825 -key "$ca_key" \
    -config "${PROJECT_ROOT}/scripts/openssl-development.cnf" -section req \
    -subj "/CN=ITS Development CA" -extensions ca_ext -out "$ca_cert"
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$server_key"
  openssl req -new -sha256 -key "$server_key" \
    -config "${PROJECT_ROOT}/scripts/openssl-development.cnf" -section req -out "$server_csr"
  openssl x509 -req -sha256 -days 397 -in "$server_csr" -CA "$ca_cert" -CAkey "$ca_key" \
    -CAcreateserial -copy_extensions copy -out "$server_cert"
  rm -f -- "$server_csr" "$serial_file"
  chmod 600 "$ca_key" "$server_key"
  unset ITS_TLS_SAN
}

setup_stack() {
  require_command docker
  require_command openssl
  require_buildkit_ssh_agent
  generate_jwt_keys
  generate_tls_certificate
  write_compose_env
  log "Building Compose images"
  compose build
  log "Starting PostgreSQL and applying migrations"
  compose up -d db
  compose run --rm node-migrate
  if [[ "$RECORDING_ENABLED" == true ]]; then
    recording_bootstrap
  fi
  log "Setup completed"
}

recording_bootstrap() {
  [[ "$RECORDING_ENABLED" == true ]] || die "recording-bootstrap requires RECORDING_ENABLED=true"
  compose --profile recording up -d minio
  compose --profile recording run --rm --no-deps minio-bootstrap
}

start_stack() {
  write_compose_env
  require_buildkit_ssh_agent
  local services=(node routing relay vision nginx coturn)
  compose up -d --build "${services[@]}"
  if [[ "$RECORDING_ENABLED" == true ]]; then
    recording_bootstrap
  fi
  log "Compose stack started"
  log "Operator: ${PUBLIC_OPERATOR_URL%/}/operator/"
  log "Live View: ${LIVE_VIEW_URL}"
}

start_component() {
  local component="${1//route-tracking/routing}"
  [[ "$component" =~ ^(node|routing|relay|vision|nginx|coturn)$ ]] || die "Unknown component '$component'"
  write_compose_env
  [[ "$component" == node ]] && require_buildkit_ssh_agent
  compose up -d --build "$component"
}

stop_component() {
  local component="${1//route-tracking/routing}"
  [[ "$component" =~ ^(node|routing|relay|vision|nginx|coturn)$ ]] || die "Unknown component '$component'"
  compose stop "$component"
}

status_stack() {
  write_compose_env
  compose ps
}

usage() {
  cat <<'USAGE'
Usage: scripts/run-linux-stack.sh [all|setup|start|restart|status|stop|down|logs|recording-bootstrap]

Individual components:
  scripts/run-linux-stack.sh start <node|routing|relay|vision|nginx|coturn>
  scripts/run-linux-stack.sh stop <node|routing|relay|vision|nginx|coturn>
  scripts/run-linux-stack.sh restart <node|routing|relay|vision|nginx|coturn>
  scripts/run-linux-stack.sh status [component]

Compose is the service supervisor. Set P4_COMPOSE_DEV=true for the explicit
source bind mounts and Node/Python reload commands from docker-compose.dev.yml.
Set RECORDING_ENABLED=true to enable MinIO and publish replay port 39003.
USAGE
}

main() {
  local action="${1:-all}"
  [[ "$action" == -h || "$action" == --help || "$action" == help ]] && { usage; return 0; }
  load_environment
  require_command docker
  write_compose_env
  case "$action" in
    all) setup_stack; start_stack ;;
    setup) setup_stack ;;
    start) [[ -n "${2:-}" ]] && start_component "$2" || start_stack ;;
    restart)
      [[ -n "${2:-}" ]] || die "restart requires a component"
      stop_component "$2"
      start_component "$2"
      ;;
    status)
      if [[ -n "${2:-}" ]]; then compose ps "$2"; else status_stack; fi
      ;;
    stop)
      if [[ -n "${2:-}" ]]; then stop_component "$2"; else compose stop; fi
      ;;
    down) compose down ;;
    logs) shift; compose logs -f "$@" ;;
    recording-bootstrap) recording_bootstrap ;;
    *) usage; die "Unknown action: $action" ;;
  esac
}

main "$@"
