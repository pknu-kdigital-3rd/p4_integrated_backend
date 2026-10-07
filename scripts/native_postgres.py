"""Manage a PostgreSQL/PostGIS process inside the existing notebook container."""
from __future__ import annotations

import os
from contextlib import contextmanager
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
import time
from urllib.parse import quote


def configure_database(env, root):
    env = env.copy()
    local = env.get("NATIVE_LOCAL_DB", "false" if env.get("DATABASE_URL") else "true")
    if local not in {"true", "false"}:
        raise ValueError("NATIVE_LOCAL_DB must be true or false")
    env["NATIVE_LOCAL_DB"] = local
    if local == "true":
        env.setdefault("POSTGRES_USER", "app")
        env.setdefault("POSTGRES_PASSWORD", "app")
        env.setdefault("POSTGRES_DB", "vehicle_platform")
        env.setdefault("NATIVE_PG_PORT", "5432")
        env.setdefault("NATIVE_PGDATA", str(root / ".runtime/native/pgdata"))
        port = int(env["NATIVE_PG_PORT"])
        if not 1 <= port <= 65535:
            raise ValueError("NATIVE_PG_PORT must be between 1 and 65535")
        if not env["POSTGRES_USER"] or not env["POSTGRES_PASSWORD"] or not env["POSTGRES_DB"]:
            raise ValueError("Local PostgreSQL requires a nonempty username, password and database")
        if "\n" in env["POSTGRES_PASSWORD"] or "\r" in env["POSTGRES_PASSWORD"]:
            raise ValueError("Local PostgreSQL password must not contain newlines")
        env["DATABASE_URL"] = (f"postgresql://{quote(env['POSTGRES_USER'], safe='')}:"
                               f"{quote(env['POSTGRES_PASSWORD'], safe='')}@127.0.0.1:{port}/"
                               f"{quote(env['POSTGRES_DB'], safe='')}?schema=public")
    return env


def install_database(env, root):
    prefix = root / ".runtime/native/postgres-env"
    manager = shutil.which("micromamba") or shutil.which("mamba") or shutil.which("conda")
    if not manager:
        raise ValueError("Install micromamba/conda first, or install PostgreSQL 17 + PostGIS and set NATIVE_POSTGRES_BIN")
    if (prefix / "conda-meta").is_dir():
        action = "install"
    else:
        action = "create"
    subprocess.run([manager, action, "--yes", "--prefix", str(prefix), "--override-channels", "--channel", "conda-forge",
                    "postgresql=17", "postgis>=3.5,<4"], env=env, check=True)
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        import pwd
        account = env.get("NATIVE_PG_RUN_AS", "postgres")
        try:
            pwd.getpwnam(account)
        except KeyError:
            if not re.fullmatch(r"[a-z_][a-z0-9_-]*", account) or not shutil.which("useradd"):
                raise ValueError("Create a non-root PostgreSQL OS user and set NATIVE_PG_RUN_AS, or run Jupyter as a regular user") from None
            subprocess.run(["useradd", "--system", "--user-group", "--no-create-home", "--home-dir", "/tmp/p4-postgres", account], check=True)


class LocalPostgres:
    def __init__(self, env, root):
        self.env = env.copy()
        self.root = root
        self.data = Path(env["NATIVE_PGDATA"]).expanduser().resolve()
        self.prefix = []
        self.owner = None
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            import pwd
            account = env.get("NATIVE_PG_RUN_AS", "postgres")
            try:
                user = pwd.getpwnam(account)
            except KeyError:
                raise ValueError("PostgreSQL cannot run as root. Run the launcher as a regular user, or create a non-root postgres user and set NATIVE_PG_RUN_AS") from None
            if user.pw_uid == 0 or not shutil.which("runuser"):
                raise ValueError("NATIVE_PG_RUN_AS must be a non-root user and runuser must be available")
            self.owner = (user.pw_uid, user.pw_gid)
            self.prefix = [shutil.which("runuser"), "-u", account, "--"]

    def binary(self, name):
        suffix = ".exe" if os.name == "nt" else ""
        configured = self.env.get("NATIVE_POSTGRES_BIN")
        directories = [Path(configured)] if configured else [self.root / ".runtime/native/postgres-env/bin"]
        for directory in directories:
            candidate = directory / (name + suffix)
            if candidate.is_file():
                return str(candidate.resolve())
        if not configured:
            available = shutil.which(name)
            if available:
                return available
        raise ValueError(f"Missing {name}: run db-setup or set NATIVE_POSTGRES_BIN to a PostgreSQL/PostGIS bin directory")

    def initialize(self):
        shared = subprocess.check_output([self.binary("pg_config"), "--sharedir"], env=self.env, text=True).strip()
        if not (Path(shared) / "extension/postgis.control").is_file():
            raise ValueError("PostGIS is not installed for this PostgreSQL distribution; install matching PostgreSQL/PostGIS packages")
        if (self.data / "PG_VERSION").is_file():
            if self.owner and self.data.stat().st_uid != self.owner[0]:
                raise ValueError("Existing PostgreSQL directory belongs to another user; use its original owner")
            return
        self.data.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.owner:
            os.chown(self.data, *self.owner)
        # initdb reads the password from a temporary private file, never argv.
        descriptor, password_file = tempfile.mkstemp(prefix="p4-pg-password-", dir=self.data.parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                stream.write(self.env["POSTGRES_PASSWORD"] + "\n")
            if self.owner:
                os.chown(password_file, *self.owner)
            subprocess.run([*self.prefix, self.binary("initdb"), "-D", str(self.data), "--username", self.env["POSTGRES_USER"],
                            "--encoding=UTF8", "--locale=C", "--auth=scram-sha-256", "--pwfile", password_file], env=self.env, check=True)
        finally:
            Path(password_file).unlink(missing_ok=True)

    def command(self):
        return [*self.prefix, self.binary("postgres"), "-D", str(self.data), "-h", "127.0.0.1", "-p", self.env["NATIVE_PG_PORT"],
                "-c", "unix_socket_directories=", "-c", "password_encryption=scram-sha-256"]

    def sql(self, query, database="postgres", check=True, variables=None):
        command = [self.binary("psql"), "-X", "--no-password", "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1", "-h", "127.0.0.1",
                   "-p", self.env["NATIVE_PG_PORT"], "-U", self.env["POSTGRES_USER"], "-d", database]
        for key, value in (variables or {}).items():
            command.extend(["--set", f"{key}={value}"])
        result = subprocess.run(command, input=query, env={**self.env, "PGPASSWORD": self.env["POSTGRES_PASSWORD"], "PGCONNECT_TIMEOUT": "2"},
                                text=True, capture_output=True, check=False)
        if check and result.returncode:
            raise RuntimeError(result.stderr.strip() or "PostgreSQL command failed")
        return result

    def ready(self, process):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError("Local PostgreSQL exited before becoming ready; see postgres.log")
            probe = self.sql("SHOW data_directory", check=False)
            if probe.returncode == 0:
                if Path(probe.stdout.strip()).resolve() != self.data:
                    raise ValueError("Another PostgreSQL cluster occupies NATIVE_PG_PORT; select a different port")
                return
            time.sleep(0.2)
        raise RuntimeError("Local PostgreSQL did not accept authenticated connections within 30 seconds; check postgres.log and the initialized password")

    def provision(self):
        self.sql("SELECT format('CREATE DATABASE %I', :'db_name') WHERE NOT EXISTS "
                 "(SELECT 1 FROM pg_database WHERE datname = :'db_name')\n\\gexec\n",
                 variables={"db_name": self.env["POSTGRES_DB"]})
        result = self.sql("CREATE EXTENSION IF NOT EXISTS postgis; SELECT PostGIS_Full_Version(); "
                          "SELECT ST_AsText(ST_SetSRID(ST_MakePoint(129,35),4326)::geography::geometry);",
                          database=self.env["POSTGRES_DB"])
        print(result.stdout, flush=True)


@contextmanager
def database_session(env, root):
    """Start a temporary local server for migration/check commands, then stop it."""
    if env["NATIVE_LOCAL_DB"] != "true":
        yield
        return
    database = LocalPostgres(env, root)
    database.initialize()
    probe = database.sql("SHOW data_directory", check=False)
    if probe.returncode == 0:
        if Path(probe.stdout.strip()).resolve() != database.data:
            raise ValueError("Another PostgreSQL cluster occupies NATIVE_PG_PORT; select a different port")
        database.provision()
        yield
        return
    logs = root / ".runtime/native/logs"
    logs.mkdir(parents=True, exist_ok=True)
    with (logs / "postgres.log").open("ab", buffering=0) as log:
        process = subprocess.Popen(database.command(), cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT,
                                   start_new_session=os.name != "nt")
    try:
        database.ready(process)
        database.provision()
        yield
    finally:
        if process.poll() is None:
            try:
                process.terminate() if os.name == "nt" else os.killpg(process.pid, signal.SIGINT)
            except ProcessLookupError:
                pass
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill() if os.name == "nt" else os.killpg(process.pid, signal.SIGKILL)
            process.wait()
