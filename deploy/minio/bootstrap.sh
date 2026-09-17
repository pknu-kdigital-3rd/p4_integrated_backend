#!/bin/sh
set -eu

if [ "${#MINIO_RECORDING_BUCKET}" -lt 3 ] || [ "${#MINIO_RECORDING_BUCKET}" -gt 63 ]; then
  echo "Invalid MINIO_RECORDING_BUCKET length" >&2
  exit 1
fi
case "$MINIO_RECORDING_BUCKET" in
  ''|*[!a-z0-9.-]*|[!a-z0-9]*|*[!a-z0-9]|*..*)
    echo "Invalid MINIO_RECORDING_BUCKET" >&2
    exit 1
    ;;
esac

mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc mb --ignore-existing "local/$MINIO_RECORDING_BUCKET"

create_policy() {
  policy_name="$1"
  policy_template="$2"
  policy_file="/tmp/${policy_name}.json"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      *__BUCKET__*)
        prefix=${line%%__BUCKET__*}
        suffix=${line#*__BUCKET__}
        line="${prefix}${MINIO_RECORDING_BUCKET}${suffix}"
        ;;
    esac
    printf '%s\n' "$line"
  done < "$policy_template" > "$policy_file"
  if ! mc admin policy info local "$policy_name" >/dev/null 2>&1; then
    mc admin policy create local "$policy_name" "$policy_file"
  fi
}

ensure_user() {
  access_key="$1"
  secret_key="$2"
  policy_name="$3"
  if ! mc admin user info local "$access_key" >/dev/null 2>&1; then
    mc admin user add local "$access_key" "$secret_key"
  fi
  mc admin policy attach local "$policy_name" --user "$access_key"
}

create_policy p4-recording-write /policies/relay.json.tmpl
create_policy p4-recording-read /policies/node.json.tmpl
create_policy p4-recording-delete /policies/node-delete.json.tmpl
ensure_user "$MINIO_RELAY_ACCESS_KEY" "$MINIO_RELAY_SECRET_KEY" p4-recording-write
ensure_user "$MINIO_NODE_ACCESS_KEY" "$MINIO_NODE_SECRET_KEY" p4-recording-read
ensure_user "$MINIO_NODE_ACCESS_KEY" "$MINIO_NODE_SECRET_KEY" p4-recording-delete
echo "MinIO bucket $MINIO_RECORDING_BUCKET and recording credentials are ready"
