import pstats
from pathlib import Path
import shutil
import threading
import unittest
import uuid
from time import thread_time, sleep
import sys
from unittest.mock import patch
from types import SimpleNamespace

from app.services.cpu_profile import ModelCpuProfile, ThreadCpuProfiler, run_model_cpu_profile


class CpuProfileTests(unittest.TestCase):
    def setUp(self):
        workspace = Path(__file__).resolve().parents[3]
        self.folder = Path(__file__).resolve().parents[1] / "__pycache__" / f"cpu-profile-tests-{uuid.uuid4().hex}"
        self.assertTrue(self.folder.resolve().is_relative_to(workspace))
        self.folder.mkdir(parents=True)
        self.addCleanup(shutil.rmtree, self.folder)

    def test_nested_self_and_cumulative_time_accounting(self):
        ticks = iter((0, 0, 1, 1, 3, 3, 6, 6))
        profiler = ThreadCpuProfiler(timer=lambda: next(ticks))
        parent = SimpleNamespace(f_code=SimpleNamespace(co_filename="test", co_firstlineno=1, co_name="parent"))
        child = SimpleNamespace(f_code=SimpleNamespace(co_filename="test", co_firstlineno=2, co_name="child"))
        profiler._event(parent, "call", None)
        profiler._event(child, "call", None)
        profiler._event(child, "return", None)
        profiler._event(parent, "return", None)
        self.assertEqual(profiler.stats[("test", 1, "parent")][:4], (1, 1, 4, 6))
        self.assertEqual(profiler.stats[("test", 2, "child")][:4], (1, 1, 2, 2))
        self.assertEqual(profiler.stats[("test", 2, "child")][4][("test", 1, "parent")], (1, 1, 2, 2))

    def test_capture_skips_warmup_stops_at_bound_and_uses_thread_cpu_clock(self):
        with patch("app.services.cpu_profile.print"):
            collector = ModelCpuProfile("yolo", 2, 1, self.folder)
            def work():
                return sum(range(1000))
            with patch("app.services.cpu_profile.print"), patch(
                "app.services.cpu_profile.ThreadCpuProfiler", wraps=ThreadCpuProfiler
            ) as create:
                for _ in range(5):
                    self.assertEqual(collector.run(work), work())
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
                    collector.run(barrier.wait, timeout=3)
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
            self.assertEqual(sum(collector.completed for collector in collectors), 2)
            self.assertTrue(all((self.folder / f"{name}.pstats").exists() for name in ("yolo", "depth")))

    def test_disabled_mode_does_not_construct_profiler(self):
        with patch("app.services.cpu_profile.settings.VISION_CPU_PROFILE_FRAMES", 0), patch(
            "app.services.cpu_profile.ThreadCpuProfiler", side_effect=AssertionError("unexpected profiling")
        ):
            self.assertEqual(run_model_cpu_profile("yolo", sum, range(10)), 45)

    def test_save_failure_does_not_fail_successful_inference(self):
        collector = ModelCpuProfile("depth", 1, 0, Path("unused"))
        with patch("pathlib.Path.mkdir", side_effect=PermissionError("read only")), patch(
            "app.services.cpu_profile.print"
        ) as output:
            self.assertEqual(collector.run(sum, range(10)), 45)
        self.assertIn("save failed", output.call_args.args[0])
        self.assertIsNone(collector.stats)

    def test_thread_profiles_exclude_background_and_have_valid_times(self):
        barrier = threading.Barrier(3)
        failures = []
        def yolo_work():
            barrier.wait(timeout=3)
            sleep(0.03)
            return sum(range(20000))
        def depth_work():
            barrier.wait(timeout=3)
            sleep(0.03)
            return sum(range(20000))
        def decode_work():
            barrier.wait(timeout=3)
            until = thread_time() + 0.04
            while thread_time() < until:
                sum(range(1000))
        def run(name, work):
            try:
                ModelCpuProfile(name, 1, 0, self.folder).run(work)
            except Exception as exc:
                failures.append(exc)
        with patch("app.services.cpu_profile.print"):
            workers = [threading.Thread(target=run, args=("yolo", yolo_work)),
                       threading.Thread(target=run, args=("depth", depth_work)),
                       threading.Thread(target=decode_work)]
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join(timeout=5)
            self.assertFalse(any(worker.is_alive() for worker in workers))
        self.assertEqual(failures, [])
        for name, own, other in (("yolo", "yolo_work", "depth_work"), ("depth", "depth_work", "yolo_work")):
            stats = pstats.Stats(str(self.folder / f"{name}.pstats"))
            names = {key[2] for key in stats.stats}
            self.assertIn(own, names)
            self.assertNotIn(other, names)
            self.assertNotIn("decode_work", names)
            for entry in stats.stats.values():
                self.assertGreaterEqual(entry[2], 0)
                self.assertGreaterEqual(entry[3], 0)
                self.assertGreaterEqual(entry[3] + 1e-9, entry[2])

    def test_existing_hook_is_preserved(self):
        collector = ModelCpuProfile("yolo", 1, 0, self.folder)
        hook = lambda *args: None
        with patch("app.services.cpu_profile.sys.getprofile", return_value=hook), patch(
            "app.services.cpu_profile.print"
        ):
            self.assertEqual(collector.run(sum, range(10)), 45)
        self.assertTrue(collector.disabled)
        self.assertFalse((self.folder / "yolo.pstats").exists())

    def test_model_exception_cleans_up_hook_and_keeps_sample(self):
        def failure():
            raise ValueError("model failed")
        collector = ModelCpuProfile("depth", 1, 0, self.folder)
        with patch("app.services.cpu_profile.print"), self.assertRaisesRegex(ValueError, "model failed"):
            collector.run(failure)
        self.assertIsNone(sys.getprofile())
        self.assertEqual(collector.completed, 1)
        self.assertTrue((self.folder / "depth.pstats").exists())

    def test_native_torch_calls_and_recursion(self):
        import torch
        def recurse(n):
            return recurse(n - 1) + 1 if n else 0
        def work():
            return torch.arange(10, device="cpu").clamp_(min=2).sum().item() + recurse(3)
        with patch("app.services.cpu_profile.print"):
            result = ModelCpuProfile("yolo", 1, 0, self.folder).run(work)
        self.assertEqual(result, 51)
        stats = pstats.Stats(str(self.folder / "yolo.pstats"))
        recursion = next(value for key, value in stats.stats.items() if key[2] == "recurse")
        self.assertEqual(recursion[:2], (1, 4))
        self.assertTrue(any("clamp_" in key[2] for key in stats.stats))
        for entry in stats.stats.values():
            self.assertGreaterEqual(entry[2], 0)
            self.assertGreaterEqual(entry[3] + 1e-9, entry[2])


if __name__ == "__main__":
    unittest.main()
