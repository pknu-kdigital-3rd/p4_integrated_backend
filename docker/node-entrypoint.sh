#!/bin/sh
set -eu

jwt_dir="${JWT_KEY_DIR:-/run/secrets/jwt}"
private_key="${jwt_dir}/private.pem"
public_key="${jwt_dir}/public.pem"

mkdir -p "$jwt_dir"
if [ ! -s "$private_key" ]; then
  umask 077
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$private_key"
fi
if [ ! -s "$public_key" ]; then
  openssl rsa -pubout -in "$private_key" -out "$public_key" >/dev/null 2>&1
fi
chmod 600 "$private_key" "$public_key"

exec "$@"
