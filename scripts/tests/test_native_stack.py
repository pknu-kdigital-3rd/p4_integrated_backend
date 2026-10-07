import importlib.util
import os
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("native_stack", Path(__file__).parents[1] / "run-native-stack.py")
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class NativeStackTests(unittest.TestCase):
    def test_export_file_preserves_secrets_and_last_override_without_shell_execution(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "env.local"
            path.write_text('export YOLO_GPU_INDEX=3\nexport VALUE="a b # c"\nVALUE="$(echo secret)"\n'
                            'export YOLO_GPU_INDEX=0 # visible GPU\nEMPTY=\nPASSWORD="a$`!#"\n')
            env = native.load_environment(path, {"BASE": "inherited"})
            self.assertEqual(env["YOLO_GPU_INDEX"], "0")
            self.assertEqual(env["VALUE"], "$(echo secret)")
            self.assertEqual(env["PASSWORD"], "a$`!#")
            self.assertEqual(env["EMPTY"], "")
            self.assertEqual(env["BASE"], "inherited")

    def test_native_profile_replaces_docker_paths_and_uses_one_public_origin(self):
        env = native.native_environment({"NATIVE_PUBLIC_URL": "https://example.ngrok.app/",
            "LIVE_VIEW_URL": "https://10.174.96.119:39002/", "RECORDING_ENABLED": "true",
            "YOLO_MODEL": "/workspace/services/vision/models/custom.engine"})
        self.assertEqual(env["LIVE_VIEW_URL"], "https://example.ngrok.app/live/")
        self.assertEqual(env["LIVE_VIEW_PARENT_ORIGINS"], "https://example.ngrok.app")
        self.assertEqual(env["YOLO_MODEL"], str(native.ROOT / "services/vision/models/custom.engine"))
        self.assertEqual(env["RECORDING_ENABLED"], "false")
        self.assertEqual(env["ANDROID_TELEMETRY_ENABLED"], "false")
        self.assertEqual(env["VISION_SOURCE"], "server")
        self.assertEqual(env["NATIVE_NODE_URL"], "http://127.0.0.1:3000")

    def test_database_required_for_dashboard_but_not_preview(self):
        for env in ({}, {"DATABASE_URL": "postgresql://app:app@p4-db:5432/vehicle_platform"}):
            with self.assertRaises(ValueError):
                native.require_database(env)
        native.require_database({"DATABASE_URL": "postgresql://app:app@db.example/vehicle_platform"})
        env = native.native_environment({})
        self.assertEqual([service[0] for service in native.service_commands(env, True)], ["vision", "gateway"])
        self.assertEqual([service[0] for service in native.service_commands(env, False)], ["routing", "node", "vision", "gateway"])

    def test_ports_and_gpu_environment_are_specific_to_each_service(self):
        env = native.native_environment({"NATIVE_NODE_PORT": "43000", "NATIVE_VISION_PORT": "43011", "YOLO_GPU_INDEX": "3"})
        commands = {name: (command, values) for name, command, _, values in native.service_commands(env, False)}
        self.assertEqual(commands["node"][1]["PORT"], "43000")
        self.assertEqual(commands["vision"][1]["PORT"], "43011")
        self.assertEqual(commands["vision"][1]["YOLO_GPU_INDEX"], "3")
        self.assertTrue(commands["vision"][1]["PATH"].startswith(str(native.python_for("vision").parent)))
        with patch.object(native.os, "name", "posix"):
            command = native.vision_command(["run.py", "--no-tls"])
            self.assertEqual(command[0], "sh")
            self.assertIn("container-entrypoint.sh", command[1])

    def test_public_url_requires_an_origin(self):
        for url in ("https://example/live/", "https://example/?query=1", "garbage", "ftp://example", "https://user:secret@example"):
            with self.assertRaises(ValueError):
                native.native_environment({"NATIVE_PUBLIC_URL": url})

    def test_failed_child_stops_other_real_processes(self):
        children = []
        original_popen = subprocess.Popen
        def start(*args, **kwargs):
            child = original_popen(*args, **kwargs)
            children.append(child)
            return child
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            env = native.native_environment({})
            services = [
                ("waiting", [sys.executable, "-c", "import time; time.sleep(60)"], root, os.environ.copy()),
                ("failed", [sys.executable, "-c", "raise SystemExit(7)"], root, os.environ.copy()),
            ]
            with patch.object(native, "ROOT", root), patch.object(native, "ensure_keys"), patch.object(native, "python_for", return_value=Path(sys.executable)), patch.object(native, "service_commands", return_value=services), patch.object(native.subprocess, "Popen", side_effect=start):
                with self.assertRaisesRegex(RuntimeError, "failed exited with code 7"):
                    native.run(env, True)
            self.assertEqual(len(children), 2)
            self.assertTrue(all(child.poll() is not None for child in children))

    def test_local_database_becomes_ready_before_apps_and_stops_with_them(self):
        children = []
        order = []
        original_popen = subprocess.Popen
        def start(*args, **kwargs):
            order.append("spawn")
            child = original_popen(*args, **kwargs)
            children.append(child)
            return child
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            env = native.native_environment({"NATIVE_LOCAL_DB": "true"})
            database = unittest.mock.Mock()
            database.command.return_value = [sys.executable, "-c", "import time; time.sleep(60)"]
            database.ready.side_effect = lambda process: order.append("database-ready")
            database.provision.side_effect = lambda: order.append("postgis-ready")
            services = [("failed", [sys.executable, "-c", "raise SystemExit(7)"], root, os.environ.copy())]
            with patch.object(native, "ROOT", root), patch.object(native, "ensure_keys"), patch.object(native, "python_for", return_value=Path(sys.executable)), patch.object(native, "service_commands", return_value=services), patch.object(native, "LocalPostgres", return_value=database), patch.object(native.subprocess, "Popen", side_effect=start):
                with self.assertRaisesRegex(RuntimeError, "failed exited"):
                    native.run(env, False)
            self.assertEqual(order, ["spawn", "database-ready", "postgis-ready", "spawn"])
            self.assertTrue(all(child.poll() is not None for child in children))


if __name__ == "__main__":
    unittest.main()
