# Repository guidance

## Vision dependencies

When changing how Vision dependencies are installed, inspect both `services/vision/pyproject.toml` and `services/vision/uv.lock`. For native or GPU packages, verify the selected wheel's source and compatibility with the locked Python, PyTorch, and CUDA versions.

Verify the operation the application actually uses; a successful install or import alone is insufficient. If that operation requires a GPU unavailable in the current environment, state that limitation explicitly instead of claiming it was verified.

Commit messages and change summaries must describe the dependency changes and checks actually performed.
