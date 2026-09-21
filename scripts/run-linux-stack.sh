#!/usr/bin/env bash
set -Eeuo pipefail

# Compose is the service supervisor. The stack has safe development defaults,
# so `docker compose up -d` is sufficient; this wrapper remains for lifecycle
# aliases and for optional shell environment overrides.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

# Keep BuildKit enabled for every Compose build, including older Docker hosts.
export DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-1}"

log() { printf '[p4-stack] %s\n' "$*"; }
die() { printf '[p4-stack] ERROR: %s\n' "$*" >&2; exit 1; }
require_command() { command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"; }

load_environment() {
  TLS_PUBLIC_ADDRESS="${TLS_PUBLIC_ADDRESS:-10.174.96.119}"
  NODE_ENV="${NODE_ENV:-production}"
  ANDROID_TELEMETRY_ENABLED="${ANDROID_TELEMETRY_ENABLED:-false}"
  PUBLIC_OPERATOR_URL="${PUBLIC_OPERATOR_URL:-https://${TLS_PUBLIC_ADDRESS}:39001}"
  VISION_PUBLIC_BASE_URL="${VISION_PUBLIC_BASE_URL:-https://${TLS_PUBLIC_ADDRESS}:39002}"
  LIVE_VIEW_URL="${LIVE_VIEW_URL:-${VISION_PUBLIC_BASE_URL}/}"
  TURN_URL="${TURN_URL:-turn:${TLS_PUBLIC_ADDRESS}:39004?transport=udp}"
  P4_COMPOSE_DEV="${P4_COMPOSE_DEV:-false}"

  [[ "$ANDROID_TELEMETRY_ENABLED" == true || "$ANDROID_TELEMETRY_ENABLED" == false ]] \
    || die "ANDROID_TELEMETRY_ENABLED must be true or false"
  [[ "$P4_COMPOSE_DEV" == true || "$P4_COMPOSE_DEV" == false ]] \
    || die "P4_COMPOSE_DEV must be true or false"
}

compose_files() {
  if [[ "$P4_COMPOSE_DEV" == true ]]; then
    printf '%s\n' -f "${PROJECT_ROOT}/docker-compose.dev.yml"
  else
    printf '%s\n' -f "${PROJECT_ROOT}/docker-compose.yml"
  fi
}

compose() {
  local args=()
  while IFS= read -r item; do args+=("$item"); done < <(compose_files)
  docker compose "${args[@]}" "$@"
}

recording_bootstrap() {
  compose up -d minio
  compose run --rm --no-deps minio-bootstrap
}

setup_stack() {
  require_command docker
  log "Building Compose images"
  compose build
  log "Starting PostgreSQL and applying migrations"
  compose up -d db
  compose run --rm node-migrate
  recording_bootstrap
  log "Setup completed"
}

start_stack() {
  local services=(node routing relay vision nginx coturn)
  compose up -d --build "${services[@]}"
  recording_bootstrap
  log "Compose stack started"
  log "Operator: ${PUBLIC_OPERATOR_URL%/}/operator/"
  log "Live View: ${LIVE_VIEW_URL}"
}

start_component() {
  local component="${1//route-tracking/routing}"
  [[ "$component" =~ ^(node|routing|relay|vision|nginx|coturn)$ ]] || die "Unknown component '$component'"
  compose up -d --build "$component"
}

stop_component() {
  local component="${1//route-tracking/routing}"
  [[ "$component" =~ ^(node|routing|relay|vision|nginx|coturn)$ ]] || die "Unknown component '$component'"
  compose stop "$component"
}

usage() {
  cat <<'USAGE'
Usage: scripts/run-linux-stack.sh [all|setup|start|restart|status|stop|down|logs|recording-bootstrap]

Individual components:
  scripts/run-linux-stack.sh start <node|routing|relay|vision|nginx|coturn>
  scripts/run-linux-stack.sh stop <node|routing|relay|vision|nginx|coturn>
  scripts/run-linux-stack.sh restart <node|routing|relay|vision|nginx|coturn>
  scripts/run-linux-stack.sh status [component]

The wrapper is optional. Plain `docker compose up -d` uses the production file
with recording enabled and replay port 39003. Set P4_COMPOSE_DEV=true to use
the standalone development Compose file with source bind mounts and reload
commands.
USAGE
}

main() {
  local action="${1:-start}"
  [[ "$action" == -h || "$action" == --help || "$action" == help ]] && { usage; return 0; }
  load_environment
  require_command docker
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
      if [[ -n "${2:-}" ]]; then compose ps "$2"; else compose ps; fi
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
