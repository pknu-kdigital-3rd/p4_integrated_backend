#!/bin/sh
set -eu

tls_dir="${TLS_DIR:-/etc/nginx/tls}"
address="${TLS_PUBLIC_ADDRESS:-10.174.96.119}"
certificate="${tls_dir}/server.crt"
private_key="${tls_dir}/server.key"

mkdir -p "$tls_dir"
if [ ! -s "$certificate" ] || [ ! -s "$private_key" ]; then
  case "$address" in
    *[!0-9.]* ) subject_alt_name="DNS:${address}" ;;
    * ) subject_alt_name="IP:${address}" ;;
  esac
  rm -f "$certificate" "$private_key"
  umask 077
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 825 \
    -keyout "$private_key" -out "$certificate" \
    -subj "/CN=${address}" \
    -addext "subjectAltName = ${subject_alt_name}" \
    >/dev/null 2>&1
fi
# The certificate is public and must be copyable to Android/browser clients.
# Apply this on every startup to repair certificates generated with umask 077.
chmod 644 "$certificate"
chmod 600 "$private_key"

exec "$@"
