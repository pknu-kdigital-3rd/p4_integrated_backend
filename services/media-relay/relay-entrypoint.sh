#!/bin/sh
set -eu

# Bind mounts are created by Docker with host-side ownership and may hide the
# ownership prepared in the image. Prepare the two directories that the relay
# must write before dropping privileges to the non-root relay user.
prepare_runtime_dir() {
    directory="$1"
    mkdir -p "$directory"

    if ! chown -R relay:relay "$directory" 2>/dev/null; then
        echo "p4-relay: could not change ownership of $directory; checking ACLs" >&2
    fi
    if ! chmod 700 "$directory" 2>/dev/null; then
        echo "p4-relay: could not change permissions of $directory; checking ACLs" >&2
    fi
    if ! su-exec relay sh -c 'test -w "$1"' sh "$directory"; then
        echo "p4-relay: $directory is not writable by the relay user" >&2
        exit 1
    fi
}

if [ "$(id -u)" -eq 0 ]; then
    prepare_runtime_dir /run/p4/relay
    prepare_runtime_dir /var/tmp/p4-recordings
    exec su-exec relay "$@"
fi

# Allow an explicit non-root Compose user to keep working. It must provide
# write access to the mounted directories itself.
exec "$@"
