import cProfile
import pstats
from pathlib import Path
import shutil
import threading
import unittest
import uuid
from time import thread_time
from unittest.mock import patch

from app.services.cpu_profile import ModelCpuProfile, model_cpu_profile


class CpuProfileTests(unittest.TestCase):
    def setUp(self):
        workspace = Path(__file__).resolve().parents[3]
        self.folder = Path(__file__).resolve().parents[1] / "__pycache__" / f"cpu-profile-tests-{uuid.uuid4().hex}"
        self.assertTrue(self.folder.resolve().is_relative_to(workspace))
        self.folder.mkdir(parents=True)
        self.addCleanup(shutil.rmtree, self.folder)

    def test_capture_skips_warmup_stops_at_bound_and_uses_thread_cpu_clock(self):
        with patch("app.services.cpu_profile.print"):
            collector = ModelCpuProfile("yolo", 2, 1, self.folder)
            def work():
                return sum(range(1000))
            with patch("app.services.cpu_profile.print"), patch(
                "app.services.cpu_profile.cProfile.Profile", wraps=cProfile.Profile
            ) as create:
                for _ in range(5):
                    with collector.capture():
                        work()
            self.assertEqual(create.call_count, 2)
            self.assertTrue(all(call.kwargs["timer"] is thread_time for call in create.call_args_list))
            self.assertEqual(collector.completed, 2)
            self.assertIsNone(collector.stats)
            stats = pstats.Stats(str(self.folder / "yolo.pstats"))
            calls = sum(value[0] for key, value in stats.stats.items() if key[2] == "work")
            self.assertEqual(calls, 2)

    def test_independent_collectors_do_not_serialize_threads(self):
        with patch("app.services.cpu_profile.print"):
            barrier = threading.Barrier(2)
            failures = []
            collectors = [ModelCpuProfile(name, 1, 0, self.folder) for name in ("yolo", "depth")]
            def run(collector):
                try:
                    with collector.capture():
                        barrier.wait(timeout=3)
                except Exception as exc:
                    failures.append(exc)
            with patch("app.services.cpu_profile.print"):
                threads = [threading.Thread(target=run, args=(collector,)) for collector in collectors]
                for worker in threads:
                    worker.start()
                for worker in threads:
                    worker.join(timeout=5)
                self.assertFalse(any(worker.is_alive() for worker in threads))
            self.assertEqual(failures, [])
            self.assertEqual(sum(collector.completed for collector in collectors), 1)
            for collector in collectors:
                with collector.capture():
                    sum(range(1000))
            self.assertTrue(all((self.folder / f"{name}.pstats").exists() for name in ("yolo", "depth")))

    def test_disabled_mode_does_not_construct_profiler(self):
        with patch("app.services.cpu_profile.settings.VISION_CPU_PROFILE_FRAMES", 0), patch(
            "app.services.cpu_profile.cProfile.Profile", side_effect=AssertionError("unexpected profiling")
        ):
            with model_cpu_profile("yolo"):
                pass

    def test_save_failure_does_not_fail_successful_inference(self):
        collector = ModelCpuProfile("depth", 1, 0, Path("unused"))
        with patch("pathlib.Path.mkdir", side_effect=PermissionError("read only")), patch(
            "app.services.cpu_profile.print"
        ) as output:
            with collector.capture():
                sum(range(10))
        self.assertIn("save failed", output.call_args.args[0])
        self.assertIsNone(collector.stats)


if __name__ == "__main__":
    unittest.main()
