# Repository guidance

## Vision dependencies

When changing how Vision dependencies are installed, inspect both `services/vision/pyproject.toml` and `services/vision/uv.lock`. For native or GPU packages, verify the selected wheel's source and compatibility with the locked Python, PyTorch, and CUDA versions.

Verify the operation the application actually uses; a successful install or import alone is insufficient. If that operation requires a GPU unavailable in the current environment, state that limitation explicitly instead of claiming it was verified.

Commit messages and change summaries must describe the dependency changes and checks actually performed.

## Docker deployment changes

Before giving deployment or restart instructions, inspect the affected service's Compose `build`, `volumes`, and `command` settings. Distinguish files baked into an image, directory bind mounts, and individual file bind mounts.

After a Git checkout or pull replaces a host file that is bind-mounted individually, recreate the affected container so Docker mounts the new file. A process reload or `docker compose restart` can reread the old mounted inode. Use `docker compose -f <compose-file> up -d --no-deps --force-recreate <service>` when the image itself has not changed; rebuild only when the image contents or build inputs changed.

Verify the effective file or configuration inside the running container before claiming the deployment is active. A successful reload and the host's Git commit do not prove the container sees the new content. For Nginx, inspect `nginx -T` and, when diagnosing routing, the access log's upstream target.
