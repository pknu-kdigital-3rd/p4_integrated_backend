#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${P4_ENV_FILE:-${PROJECT_ROOT}/deploy/env.local}"
RUNTIME_DIR="${P4_RUNTIME_DIR:-${PROJECT_ROOT}/.runtime}"
LOG_DIR="${RUNTIME_DIR}/logs"
PID_DIR="${RUNTIME_DIR}/pids"
BIN_DIR="${RUNTIME_DIR}/bin"
TLS_DIR="${PROJECT_ROOT}/secrets/tls"
NGINX_PREFIX="${PROJECT_ROOT}/deploy/nginx/"

log() {
  printf '[p4-stack] %s\n' "$*"
}

die() {
  printf '[p4-stack] ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

load_node_runtime() {
  if command -v node >/dev/null 2>&1 \
    && command -v npm >/dev/null 2>&1 \
    && command -v npx >/dev/null 2>&1; then
    log "Using Node $(node --version) from PATH"
    return 0
  fi

  NODE_VERSION="${NODE_VERSION:-lts/*}"
  local account_home="${HOME:-}"
  if [[ -z "$account_home" ]] && command -v getent >/dev/null 2>&1; then
    account_home="$(getent passwd "$(id -u)" | cut -d: -f6)"
  fi

  local candidates=()
  [[ -n "${NVM_DIR:-}" ]] && candidates+=("${NVM_DIR}/nvm.sh")
  if [[ -n "$account_home" ]]; then
    candidates+=("${account_home}/.nvm/nvm.sh")
    candidates+=("${XDG_CONFIG_HOME:-${account_home}/.config}/nvm/nvm.sh")
  fi
  candidates+=("/usr/local/share/nvm/nvm.sh")

  local nvm_script=""
  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -s "$candidate" ]]; then
      nvm_script="$candidate"
      break
    fi
  done
  [[ -n "$nvm_script" ]] \
    || die "Node is not on PATH and nvm.sh was not found. Set NVM_DIR in $ENV_FILE."
  NVM_DIR="$(cd -- "$(dirname -- "$nvm_script")" && pwd)"
  export NVM_DIR NODE_VERSION

  log "Loading nvm from $nvm_script"
  set +u
  # shellcheck disable=SC1090
  source "$nvm_script"

  if ! nvm use --silent "$NODE_VERSION" >/dev/null 2>&1; then
    log "Installing Node $NODE_VERSION with nvm"
    nvm install "$NODE_VERSION"
    nvm use --silent "$NODE_VERSION" >/dev/null
  fi
  set -u

  require_command node
  require_command npm
  require_command npx
  log "Using Node $(node --version) from nvm"
}

load_environment() {
  [[ -f "$ENV_FILE" ]] || die "Missing $ENV_FILE. Copy deploy/env.local.example to deploy/env.local and edit it."
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a

  : "${P4_ROOT:?P4_ROOT is required in $ENV_FILE}"
  : "${HOST:?HOST is required in $ENV_FILE}"
  : "${NODE_PORT:?NODE_PORT is required in $ENV_FILE}"
  : "${ROUTING_PORT:?ROUTING_PORT is required in $ENV_FILE}"
  : "${VISION_PORT:?VISION_PORT is required in $ENV_FILE}"
  : "${RELAY_LISTEN_ADDR:?RELAY_LISTEN_ADDR is required in $ENV_FILE}"
  : "${PUBLIC_OPERATOR_URL:?PUBLIC_OPERATOR_URL is required in $ENV_FILE}"
  : "${VISION_PUBLIC_BASE_URL:?VISION_PUBLIC_BASE_URL is required in $ENV_FILE}"
  : "${LIVE_VIEW_URL:?LIVE_VIEW_URL is required in $ENV_FILE}"
  : "${TLS_PUBLIC_ADDRESS:?TLS_PUBLIC_ADDRESS is required in $ENV_FILE}"

  [[ "$PUBLIC_OPERATOR_URL" == https://* ]] || die "PUBLIC_OPERATOR_URL must use HTTPS"
  [[ "$VISION_PUBLIC_BASE_URL" == https://* ]] || die "VISION_PUBLIC_BASE_URL must use HTTPS"
  [[ "$LIVE_VIEW_URL" == https://* ]] || die "LIVE_VIEW_URL must use HTTPS"

  local configured_root
  configured_root="$(cd -- "$P4_ROOT" 2>/dev/null && pwd)" || die "P4_ROOT does not exist: $P4_ROOT"
  [[ "$configured_root" == "$PROJECT_ROOT" ]] || die "P4_ROOT must point to this checkout: $PROJECT_ROOT"

  HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-300}"
  [[ "$HEALTH_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || die "HEALTH_TIMEOUT_SECONDS must be a positive integer"
}

preflight() {
  load_node_runtime
  local command_name
  for command_name in docker uv go openssl curl nginx nvidia-smi; do
    require_command "$command_name"
  done
  docker compose version >/dev/null
  nvidia-smi --query-gpu=name --format=csv,noheader | grep -Fq 'RTX 3090' \
    || die "RTX 3090 was not detected by nvidia-smi"
}

generate_jwt_keys() {
  mkdir -p "${PROJECT_ROOT}/secrets/jwt"
  if [[ ! -f "$JWT_PRIVATE_KEY_PATH" ]]; then
    log "Generating JWT private key"
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$JWT_PRIVATE_KEY_PATH"
    chmod 600 "$JWT_PRIVATE_KEY_PATH"
  fi
  if [[ ! -f "$JWT_PUBLIC_KEY_PATH" ]]; then
    log "Generating JWT public key"
    openssl rsa -pubout -in "$JWT_PRIVATE_KEY_PATH" -out "$JWT_PUBLIC_KEY_PATH"
  fi
}

generate_tls_certificate() {
  local ca_key="${TLS_DIR}/development-ca.key"
  local ca_cert="${TLS_DIR}/development-ca.crt"
  local server_key="${TLS_DIR}/server.key"
  local server_csr="${TLS_DIR}/server.csr"
  local server_cert="${TLS_DIR}/server.crt"
  local serial_file="${TLS_DIR}/development-ca.srl"
  local present=0
  local path

  mkdir -p "$TLS_DIR"
  for path in "$ca_key" "$ca_cert" "$server_key" "$server_cert"; do
    [[ -e "$path" ]] && present=$((present + 1))
  done

  if (( present == 0 )); then
    log "Generating development CA and TLS certificate for ${TLS_PUBLIC_ADDRESS}"
    export ITS_TLS_SAN="IP:${TLS_PUBLIC_ADDRESS}"
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$ca_key"
    openssl req -x509 -new -sha256 -days 825 \
      -key "$ca_key" \
      -config "${PROJECT_ROOT}/scripts/openssl-development.cnf" -section req \
      -subj "/CN=ITS Development CA" -extensions ca_ext \
      -out "$ca_cert"
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$server_key"
    openssl req -new -sha256 -key "$server_key" \
      -config "${PROJECT_ROOT}/scripts/openssl-development.cnf" -section req \
      -out "$server_csr"
    openssl x509 -req -sha256 -days 397 -in "$server_csr" \
      -CA "$ca_cert" -CAkey "$ca_key" -CAcreateserial \
      -copy_extensions copy -out "$server_cert"
    rm -f -- "$server_csr" "$serial_file"
    chmod 600 "$ca_key" "$server_key"
    unset ITS_TLS_SAN
  elif (( present != 4 )); then
    die "TLS directory is incomplete. Preserve or repair ${TLS_DIR}; files were not overwritten."
  fi

  openssl verify -CAfile "$ca_cert" "$server_cert"
  openssl x509 -in "$server_cert" -noout -checkend 0 >/dev/null \
    || die "TLS server certificate is expired"
  openssl x509 -in "$server_cert" -noout -ext subjectAltName | grep -Fq "IP Address:${TLS_PUBLIC_ADDRESS}" \
    || die "TLS certificate SAN does not contain ${TLS_PUBLIC_ADDRESS}"
}

wait_for_http() {
  local name="$1"
  local url="$2"
  local ca_file="${3:-}"
  local elapsed=0
  local curl_args=(-fsS --max-time 3)
  [[ -n "$ca_file" ]] && curl_args+=(--cacert "$ca_file")

  while (( elapsed < HEALTH_TIMEOUT_SECONDS )); do
    if curl "${curl_args[@]}" "$url" >/dev/null 2>&1; then
      log "$name is healthy: $url"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

wait_for_database() {
  local elapsed=0
  while (( elapsed < HEALTH_TIMEOUT_SECONDS )); do
    if docker compose -f "${PROJECT_ROOT}/docker-compose.yml" exec -T db \
      pg_isready -U app -d vehicle_platform >/dev/null 2>&1; then
      log "PostgreSQL/PostGIS is ready"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  die "PostgreSQL did not become ready; inspect: docker compose logs db"
}

setup_stack() {
  preflight
  mkdir -p "$LOG_DIR" "$PID_DIR" "$BIN_DIR" "${NGINX_PREFIX}/logs"
  generate_jwt_keys
  generate_tls_certificate

  log "Starting PostgreSQL/PostGIS"
  docker compose -f "${PROJECT_ROOT}/docker-compose.yml" up -d db
  wait_for_database

  log "Installing and validating Node dependencies"
  (
    cd "${PROJECT_ROOT}/node"
    # TypeScript compilation and Prisma tooling require devDependencies.
    # Set NODE_ENV explicitly for compatibility with older npm versions that
    # do not understand --include=dev and otherwise omit them in production.
    NODE_ENV=development npm ci --include=dev
    npx prisma migrate deploy
    npx tsx prisma/seed.ts
    npm run build
  )

  log "Installing route/tracking dependencies"
  (cd "${PROJECT_ROOT}/services/routing-tracking" && uv sync)

  log "Building the Go media relay"
  (
    cd "${PROJECT_ROOT}/services/media-relay"
    go mod download
    go build -o "${BIN_DIR}/media-relay" .
  )

  log "Installing Vision dependencies and verifying CUDA"
  (
    cd "${PROJECT_ROOT}/services/vision"
    uv sync
    uv run python -c 'import torch; assert torch.cuda.is_available(), "CUDA unavailable"; name=torch.cuda.get_device_name(0); assert "3090" in name, name; print(name); print(torch.cuda.get_arch_list())'
  )

  log "Validating Nginx configuration"
  nginx -p "$NGINX_PREFIX" -t -c nginx.conf
  log "Setup completed"
}

pid_is_running() {
  local pid_file="$1"
  [[ -f "$pid_file" ]] || return 1
  local pid
  pid="$(<"$pid_file")"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

start_service() {
  local name="$1"
  local workdir="$2"
  shift 2
  local pid_file="${PID_DIR}/${name}.pid"
  local log_file="${LOG_DIR}/${name}.log"

  if pid_is_running "$pid_file"; then
    log "$name is already running with PID $(<"$pid_file")"
    return 0
  fi
  rm -f -- "$pid_file"
  log "Starting $name; log: $log_file"
  (
    cd "$workdir"
    nohup "$@" >"$log_file" 2>&1 &
    printf '%s\n' "$!" >"$pid_file"
  )
  sleep 1
  if ! pid_is_running "$pid_file"; then
    tail -n 80 "$log_file" >&2 || true
    die "$name exited during startup"
  fi
}

start_nginx() {
  local nginx_pid_file="${NGINX_PREFIX}/logs/nginx.pid"
  nginx -p "$NGINX_PREFIX" -t -c nginx.conf
  if [[ -f "$nginx_pid_file" ]] && kill -0 "$(<"$nginx_pid_file")" 2>/dev/null; then
    log "Reloading Nginx"
    nginx -p "$NGINX_PREFIX" -c nginx.conf -s reload
  else
    rm -f -- "$nginx_pid_file"
    log "Starting Nginx"
    nginx -p "$NGINX_PREFIX" -c nginx.conf
  fi
}

show_service_log() {
  local name="$1"
  local log_file="${LOG_DIR}/${name}.log"
  [[ -f "$log_file" ]] && tail -n 80 "$log_file" >&2 || true
}

start_stack() {
  load_node_runtime
  mkdir -p "$LOG_DIR" "$PID_DIR" "$BIN_DIR" "${NGINX_PREFIX}/logs"
  [[ -x "${BIN_DIR}/media-relay" ]] || die "Relay binary is missing. Run setup or all first."

  start_service node "${PROJECT_ROOT}/node" \
    env PORT="$NODE_PORT" "${PROJECT_ROOT}/node/node_modules/.bin/tsx" src/server.ts
  wait_for_http "Node" "http://${HOST}:${NODE_PORT}/health/ready" \
    || { show_service_log node; die "Node health check failed"; }

  start_service routing "${PROJECT_ROOT}/services/routing-tracking" \
    uv run uvicorn main:app --host "$HOST" --port "$ROUTING_PORT"
  wait_for_http "Route/tracking" "http://${HOST}:${ROUTING_PORT}/health/ready" \
    || { show_service_log routing; die "Route/tracking health check failed"; }

  start_service relay "${PROJECT_ROOT}/services/media-relay" "${BIN_DIR}/media-relay"
  wait_for_http "Go relay" "http://${RELAY_LISTEN_ADDR}/healthz" \
    || { show_service_log relay; die "Relay health check failed"; }

  start_service vision "${PROJECT_ROOT}/services/vision" \
    env PORT="$VISION_PORT" uv run python run.py --no-tls
  wait_for_http "Vision" "http://${HOST}:${VISION_PORT}/health/live" \
    || { show_service_log vision; die "Vision health check failed"; }

  start_nginx
  local ca_cert="${TLS_DIR}/development-ca.crt"
  wait_for_http "Public operator" "${PUBLIC_OPERATOR_URL%/}/health/live" "$ca_cert" \
    || die "Public operator HTTPS health check failed"
  wait_for_http "Public Vision" "${VISION_PUBLIC_BASE_URL%/}/health/live" "$ca_cert" \
    || die "Public Vision HTTPS health check failed"

  log "Stack is ready"
  log "Operator: ${PUBLIC_OPERATOR_URL%/}/operator/"
  log "Live View: ${LIVE_VIEW_URL}"
}

stop_service() {
  local name="$1"
  local pid_file="${PID_DIR}/${name}.pid"
  if ! pid_is_running "$pid_file"; then
    rm -f -- "$pid_file"
    log "$name is not running"
    return 0
  fi
  local pid
  pid="$(<"$pid_file")"
  log "Stopping $name (PID $pid)"
  kill "$pid"
  local attempt
  for attempt in {1..20}; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then
    die "$name did not stop; inspect PID $pid"
  fi
  rm -f -- "$pid_file"
}

stop_nginx() {
  local nginx_pid_file="${NGINX_PREFIX}/logs/nginx.pid"
  if [[ -f "$nginx_pid_file" ]] && kill -0 "$(<"$nginx_pid_file")" 2>/dev/null; then
    log "Stopping Nginx"
    nginx -p "$NGINX_PREFIX" -c nginx.conf -s quit
  else
    rm -f -- "$nginx_pid_file"
    log "Nginx is not running under the project prefix"
  fi
}

stop_stack() {
  stop_nginx
  stop_service vision
  stop_service relay
  stop_service routing
  stop_service node
}

status_line() {
  local name="$1"
  local url="$2"
  local pid_file="${PID_DIR}/${name}.pid"
  if pid_is_running "$pid_file" && curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then
    printf '%-10s RUNNING pid=%s %s\n' "$name" "$(<"$pid_file")" "$url"
  else
    printf '%-10s NOT_READY %s\n' "$name" "$url"
    return 1
  fi
}

status_stack() {
  local failed=0
  status_line node "http://${HOST}:${NODE_PORT}/health/ready" || failed=1
  status_line routing "http://${HOST}:${ROUTING_PORT}/health/ready" || failed=1
  status_line relay "http://${RELAY_LISTEN_ADDR}/healthz" || failed=1
  status_line vision "http://${HOST}:${VISION_PORT}/health/live" || failed=1
  curl -fsS --max-time 3 --cacert "${TLS_DIR}/development-ca.crt" \
    "${PUBLIC_OPERATOR_URL%/}/health/live" >/dev/null 2>&1 \
    && printf '%-10s READY %s\n' nginx "$PUBLIC_OPERATOR_URL" \
    || { printf '%-10s NOT_READY %s\n' nginx "$PUBLIC_OPERATOR_URL"; failed=1; }
  return "$failed"
}

usage() {
  cat <<'USAGE'
Usage: scripts/run-linux-stack.sh [all|setup|start|status|stop|down]

  all     Run setup, start every service, and require all health checks (default)
  setup   Install/sync dependencies, prepare DB/keys/certs, and validate CUDA/Nginx
  start   Start services and require all internal/public health checks
  status  Show process and health status; nonzero exit means not fully ready
  stop    Stop Nginx and the four application services; leave PostgreSQL running
  down    Stop the stack and stop PostgreSQL
USAGE
}

main() {
  local action="${1:-all}"
  if [[ "$action" == "-h" || "$action" == "--help" || "$action" == "help" ]]; then
    usage
    return 0
  fi
  load_environment
  case "$action" in
    all)
      setup_stack
      start_stack
      ;;
    setup) setup_stack ;;
    start) start_stack ;;
    status) status_stack ;;
    stop) stop_stack ;;
    down)
      stop_stack
      docker compose -f "${PROJECT_ROOT}/docker-compose.yml" stop db
      ;;
    *) usage; die "Unknown action: $action" ;;
  esac
}

main "$@"
