import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).parents[1]))
import native_postgres as pg


class NativePostgresTests(unittest.TestCase):
    def test_local_url_encodes_credentials_and_uses_persistent_data(self):
        env = pg.configure_database({"NATIVE_LOCAL_DB": "true", "POSTGRES_USER": "a@b", "POSTGRES_PASSWORD": "a:/#?",
                                     "NATIVE_PG_PORT": "5433"}, Path("/project"))
        self.assertEqual(env["DATABASE_URL"], "postgresql://a%40b:a%3A%2F%23%3F@127.0.0.1:5433/vehicle_platform?schema=public")
        self.assertEqual(env["NATIVE_PGDATA"], str(Path("/project/.runtime/native/pgdata")))
        self.assertEqual(pg.configure_database({}, Path("/project"))["NATIVE_LOCAL_DB"], "true")
        external = pg.configure_database({"DATABASE_URL": "postgresql://remote/db"}, Path("/project"))
        self.assertEqual(external["NATIVE_LOCAL_DB"], "false")
        self.assertEqual(external["DATABASE_URL"], "postgresql://remote/db")

    def database(self, root):
        env = pg.configure_database({"NATIVE_LOCAL_DB": "true", "NATIVE_PGDATA": str(root / "pgdata"),
                                     "POSTGRES_PASSWORD": "hidden-password"}, root)
        with patch.object(pg.os, "geteuid", return_value=1000, create=True):
            database = pg.LocalPostgres(env, root)
        database.binary = Mock(side_effect=lambda name: name)
        return database

    def test_initialization_preserves_existing_cluster_and_uses_private_password_file(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "share/extension").mkdir(parents=True)
            (root / "share/extension/postgis.control").write_text("postgis")
            database = self.database(root)
            observed = []
            def initialize(command, **kwargs):
                password_file = Path(command[command.index("--pwfile") + 1])
                self.assertEqual(password_file.read_text(), "hidden-password\n")
                self.assertNotIn("hidden-password", command)
                self.assertIn("--auth=scram-sha-256", command)
                observed.append(password_file)
                (database.data / "PG_VERSION").write_text("17")
            with patch.object(pg.subprocess, "check_output", return_value=str(root / "share")), patch.object(pg.subprocess, "run", side_effect=initialize) as run:
                database.initialize()
                self.assertFalse(observed[0].exists())
                database.initialize()
                self.assertEqual(run.call_count, 1)
                self.assertEqual((database.data / "PG_VERSION").read_text(), "17")

    def test_postgis_must_match_the_selected_postgres_distribution(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            database = self.database(root)
            with patch.object(pg.subprocess, "check_output", return_value=str(root / "missing-share")):
                with self.assertRaisesRegex(ValueError, "PostGIS is not installed"):
                    database.initialize()
            self.assertFalse(database.data.exists())

    def test_database_name_is_psql_variable_and_spatial_operation_is_checked(self):
        with tempfile.TemporaryDirectory() as folder:
            database = self.database(Path(folder))
            database.env["POSTGRES_DB"] = "a'; DROP DATABASE postgres; --"
            database.sql = Mock(return_value=SimpleResult())
            database.provision()
            first, second = database.sql.call_args_list
            self.assertNotIn(database.env["POSTGRES_DB"], first.args[0])
            self.assertEqual(first.kwargs["variables"]["db_name"], database.env["POSTGRES_DB"])
            self.assertIn("format('CREATE DATABASE %I', :'db_name')", first.args[0])
            self.assertIn("CREATE EXTENSION IF NOT EXISTS postgis", second.args[0])
            self.assertIn("::geography::geometry", second.args[0])

    def test_sql_password_stays_out_of_argv_and_port_conflicts_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            database = self.database(Path(folder))
            with patch.object(pg.subprocess, "run", return_value=SimpleResult()) as run:
                database.sql("SELECT 1")
            command = run.call_args.args[0]
            self.assertNotIn("hidden-password", command)
            self.assertEqual(run.call_args.kwargs["env"]["PGPASSWORD"], "hidden-password")
            database.sql = Mock(return_value=SimpleResult(stdout=str(Path(folder) / "other-cluster")))
            with self.assertRaisesRegex(ValueError, "Another PostgreSQL cluster"):
                database.ready(Mock(poll=Mock(return_value=None)))

    def test_server_listens_only_on_loopback(self):
        with tempfile.TemporaryDirectory() as folder:
            database = self.database(Path(folder))
            command = database.command()
            self.assertEqual(command[command.index("-h") + 1], "127.0.0.1")
            self.assertIn("unix_socket_directories=", command)
            self.assertNotIn("hidden-password", command)

    def test_commands_reuse_only_their_own_running_cluster(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            database = self.database(root)
            database.initialize = Mock()
            database.provision = Mock()
            for matching in (True, False):
                database.sql = Mock(return_value=SimpleResult(stdout=str(database.data if matching else root / "foreign-data")))
                with patch.object(pg, "LocalPostgres", return_value=database), patch.object(pg.subprocess, "Popen") as start:
                    if matching:
                        with pg.database_session(database.env, root):
                            pass
                        database.provision.assert_called_once()
                    else:
                        with self.assertRaisesRegex(ValueError, "Another PostgreSQL cluster"):
                            with pg.database_session(database.env, root):
                                self.fail("Foreign cluster was accepted")
                    start.assert_not_called()


class SimpleResult:
    def __init__(self, stdout="PostGIS spatial query passed\n", returncode=0):
        self.stdout, self.returncode = stdout, returncode


if __name__ == "__main__":
    unittest.main()
