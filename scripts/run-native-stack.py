"""Run the existing server-source services without Docker or root privileges."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from native_postgres import LocalPostgres, configure_database, database_session, install_database

ROOT = Path(__file__).resolve().parent.parent


def load_environment(path, inherited=None):
    env = dict(os.environ if inherited is None else inherited)
    if path:
        for number, line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[7:]
            key, separator, value = line.partition("=")
            if not separator or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key.strip()):
                raise ValueError(f"Unsupported environment assignment at line {number}")
            parts = shlex.split(value, comments=True)
            if len(parts) > 1:
                raise ValueError(f"Quote values containing spaces at line {number}")
            env[key.strip()] = parts[0] if parts else ""
    return env


def native_environment(env):
    env = env.copy()
    runtime = ROOT / ".runtime" / "native"
    port = int(env.get("NATIVE_GATEWAY_PORT", "39001"))
    public = env.get("NATIVE_PUBLIC_URL", f"https://localhost:{port}").rstrip("/")
    url = urlparse(public)
    if url.scheme not in {"http", "https"} or not url.hostname or url.path or url.query or url.fragment or url.username or url.password:
        raise ValueError("NATIVE_PUBLIC_URL must be an HTTP(S) origin without a path")
    env.update({
        "VISION_SOURCE": "server", "RECORDING_ENABLED": "false", "ANDROID_TELEMETRY_ENABLED": "false",
        "HOST": "127.0.0.1", "TRUST_PROXY": "true",
        "PUBLIC_OPERATOR_URL": public, "VISION_PUBLIC_BASE_URL": public + "/live/",
        "LIVE_VIEW_URL": public + "/live/", "LIVE_VIEW_PARENT_ORIGINS": public,
        "NATIVE_NODE_URL": f"http://127.0.0.1:{env.get('NATIVE_NODE_PORT', '3000')}",
        "NATIVE_ROUTING_URL": f"http://127.0.0.1:{env.get('NATIVE_ROUTING_PORT', '8000')}",
        "NATIVE_VISION_URL": f"http://127.0.0.1:{env.get('NATIVE_VISION_PORT', '39011')}",
        "NATIVE_GATEWAY_PORT": str(port),
        "JWT_PRIVATE_KEY_PATH": str(runtime / "jwt" / "private.pem"),
        "JWT_PUBLIC_KEY_PATH": str(runtime / "jwt" / "public.pem"),
        "JWT_ISSUER": "project4-node", "JWT_AUDIENCE": "project4-api",
        "JWT_ACCESS_TOKEN_TTL": "never", "JWT_KEY_ID": "project4-native",
        "TELEMETRY_MODE_STATE_PATH": str(runtime / "routing" / "telemetry-mode.json"),
        "MEDIA_RELAY_INTERNAL_BASE_URL": "http://127.0.0.1:39012",
        "NODE_INTERNAL_BASE_URL": f"http://127.0.0.1:{env.get('NATIVE_NODE_PORT', '3000')}",
        "NATIVE_TLS_CERT": str(runtime / "tls" / "server.crt"),
        "NATIVE_TLS_KEY": str(runtime / "tls" / "server.key"),
        # Do not install into or alter Jupyter's Python environment.
        "UV_PROJECT_ENVIRONMENT": ".venv", "PYTHONUNBUFFERED": "1",
    })
    env.setdefault("NODE_ENV", "production" if url.scheme == "https" else "development")
    env.setdefault("OPERATOR_DEMO_PUBLIC", "true")
    env.setdefault("ROUTING_GRAPH_BACKEND", "auto")
    env.setdefault("VISION_FRAME_PREP_THREAD", "decode")
    env.setdefault("YOLO_MODEL", str(ROOT / "services/vision/models/a4_best_640.engine"))
    env.setdefault("UNIDEPTH_MODEL_DIR", str(ROOT / "services/vision/models/unidepth-v2-vitb14"))
    for name in ("YOLO_MODEL", "UNIDEPTH_MODEL_DIR"):
        if env[name].startswith("/workspace/"):
            env[name] = str(ROOT / env[name][len("/workspace/"):])
    return configure_database(env, ROOT)


def execute(command, cwd, env):
    subprocess.run(command, cwd=cwd, env=env, check=True)


def python_for(service):
    return ROOT / "services" / service / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def require_database(env):
    if not env.get("DATABASE_URL"):
        raise ValueError("Set DATABASE_URL to a reachable PostgreSQL/PostGIS database, or use --vision-only")
    if urlparse(env["DATABASE_URL"]).hostname == "p4-db":
        raise ValueError("DATABASE_URL uses Docker hostname p4-db; use a reachable database host")


def setup(env, vision_only):
    for executable in ("uv", "node"):
        if not shutil.which(executable):
            raise ValueError(f"Install {executable} in your user environment first")
    vision = ROOT / "services/vision"
    if not (vision / ".ultralytics-custom/pyproject.toml").is_file():
        raise ValueError("Restore services/vision/.ultralytics-custom (the trained model's custom fork) first")
    execute(["uv", "sync", "--frozen", "--python", "3.12"], vision, env)
    if not vision_only:
        if not shutil.which("npm"):
            raise ValueError("Install Node.js 22 with npm first")
        execute(["uv", "sync", "--frozen", "--python", "3.12", "--extra", "osmnx"], ROOT / "services/routing-tracking", env)
        vendor = ROOT / "node/vendor/zod-to-openapi"
        execute(["npm", "ci", "--include=dev", "--ignore-scripts"], vendor, env)
        execute(["npm", "run", "build"], vendor, env)
        # Share the application's Zod instance rather than a vendor-local copy.
        shutil.rmtree(vendor / "node_modules/zod", ignore_errors=True)
        execute(["npm", "ci", "--include=dev", "--ignore-scripts"], ROOT / "node", env)
        # As in the Docker build, use the checked-in Prisma client and TypedSQL
        # helpers. Regeneration can remove the custom createTrip helper.
        execute(["npm", "run", "build"], ROOT / "node", env)


def ensure_keys(env):
    # cryptography is already locked by Vision's aiortc dependencies.
    execute([str(python_for("vision")), str(ROOT / "scripts/native-keys.py")], ROOT, env)


def service_commands(env, vision_only):
    services = []
    if not vision_only:
        services.extend([
            ("routing", [str(python_for("routing-tracking")), "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", env.get("NATIVE_ROUTING_PORT", "8000")], ROOT / "services/routing-tracking", env),
            ("node", ["node", "dist/server.js"], ROOT / "node", {**env, "PORT": env.get("NATIVE_NODE_PORT", "3000")}),
        ])
    vision_env = vision_environment(env)
    services.append(("vision", vision_command(["run.py", "--no-tls"]), ROOT / "services/vision", vision_env))
    services.append(("gateway", ["node", str(ROOT / "scripts/native-gateway.mjs")], ROOT, env))
    return services


def vision_environment(env):
    return {**env, "PORT": env.get("NATIVE_VISION_PORT", "39011"),
            "PATH": str(python_for("vision").parent) + os.pathsep + env.get("PATH", "")}


def vision_command(arguments):
    command = [str(python_for("vision")), *arguments]
    if os.name != "nt":
        # This entrypoint only selects visible GPUs; it needs no Docker APIs.
        command = ["sh", str(ROOT / "services/vision/container-entrypoint.sh"), *command]
    return command


def run(env, vision_only):
    if not vision_only:
        require_database(env)
    for service in (["vision"] if vision_only else ["vision", "routing-tracking"]):
        if not python_for(service).is_file():
            raise ValueError("Run setup first to create the service virtual environments")
    ensure_keys(env)
    logs = ROOT / ".runtime/native/logs"
    logs.mkdir(parents=True, exist_ok=True)
    processes = []
    def interrupted(signum, frame):
        raise KeyboardInterrupt
    previous_handler = signal.signal(signal.SIGTERM, interrupted)
    try:
        if not vision_only and env["NATIVE_LOCAL_DB"] == "true":
            database = LocalPostgres(env, ROOT)
            database.initialize()
            with (logs / "postgres.log").open("ab", buffering=0) as log:
                postgres = subprocess.Popen(database.command(), cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT,
                                            start_new_session=os.name != "nt")
            processes.append(("postgres", postgres))
            database.ready(postgres)
            database.provision()
            print("Local PostgreSQL/PostGIS ready", flush=True)
        for name, command, cwd, service_env in service_commands(env, vision_only):
            with (logs / f"{name}.log").open("ab", buffering=0) as log:
                process = subprocess.Popen(command, cwd=cwd, env=service_env, stdout=log, stderr=subprocess.STDOUT,
                                           start_new_session=os.name != "nt")
            processes.append((name, process))
            print(f"Started {name}; log: {logs / (name + '.log')}", flush=True)
        print(f"Preview: {env['LIVE_VIEW_URL']}", flush=True)
        if not vision_only:
            print(f"Operator: {env['PUBLIC_OPERATOR_URL']}/operator/", flush=True)
        print("Processes are starting; check logs and /health/vision. Ctrl+C stops all services.", flush=True)
        while True:
            for name, process in processes:
                if process.poll() is not None:
                    raise RuntimeError(f"{name} exited with code {process.returncode}; see {logs / (name + '.log')}")
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        signal.signal(signal.SIGTERM, previous_handler)
        for name, process in reversed(processes):
            if process.poll() is None:
                try:
                    process.terminate() if os.name == "nt" else os.killpg(process.pid, signal.SIGINT if name == "postgres" else signal.SIGTERM)
                except ProcessLookupError:
                    pass
        for _, process in processes:
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill() if os.name == "nt" else os.killpg(process.pid, signal.SIGKILL)
                process.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["setup", "db-setup", "db-check", "db-init", "vision-check", "run"])
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--vision-only", action="store_true")
    args = parser.parse_args()
    env = native_environment(load_environment(args.env_file))
    if args.action == "setup":
        setup(env, args.vision_only)
    elif args.action == "db-setup":
        install_database(env, ROOT)
    elif args.action == "run":
        run(env, args.vision_only)
    elif args.action == "vision-check":
        execute(vision_command([str(ROOT / "scripts/native-vision-check.py")]), ROOT / "services/vision", vision_environment(env))
    else:
        require_database(env)
        with database_session(env, ROOT):
            if args.action == "db-check":
                execute(["node", str(ROOT / "scripts/native-db-check.mjs")], ROOT / "node", env)
            else:
                execute(["node", "node_modules/prisma/build/index.js", "migrate", "deploy", "--config", "prisma7.config.ts"], ROOT / "node", env)
                ensure_keys(env)
                execute(["node", "node_modules/tsx/dist/cli.mjs", "prisma/seed.ts"], ROOT / "node", env)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, subprocess.CalledProcessError, OSError) as exc:
        print(f"Native stack: {exc}", file=sys.stderr)
        sys.exit(1)
