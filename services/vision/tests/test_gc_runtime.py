import asyncio
from contextlib import suppress
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from pydantic import ValidationError

from app.core.settings import Settings
from app.core.state import AppState, InferenceFrame
from app.services.gc_runtime import _freeze_loaded_objects, configure_gc, frozen_count_at_freeze
from app.services.yolo import yolo_worker


class GCRuntimeTests(unittest.TestCase):
    def test_collects_before_freezing_and_logs_count(self):
        calls = []
        with patch("app.services.gc_runtime.gc.collect", side_effect=lambda: calls.append("collect")), patch(
            "app.services.gc_runtime.gc.freeze", side_effect=lambda: calls.append("freeze")
        ), patch("app.services.gc_runtime.gc.get_freeze_count", return_value=123), patch(
            "app.services.gc_runtime.perf_counter", side_effect=[1.0, 1.2]
        ), patch("app.services.gc_runtime.print") as log:
            _freeze_loaded_objects("test startup")
        self.assertEqual(calls, ["collect", "freeze"])
        log.assert_called_once_with("GC: froze 123 objects after test startup in 0.2 s", flush=True)
        with patch("gc.get_freeze_count", side_effect=AssertionError("periodic frozen heap scan")):
            self.assertEqual(frozen_count_at_freeze(), 123)

    def test_threshold_override_preserves_older_generation_thresholds(self):
        with patch("app.services.gc_runtime.gc.get_threshold", return_value=(700, 11, 12)), patch(
            "app.services.gc_runtime.gc.set_threshold"
        ) as setter, patch("app.services.gc_runtime.print"):
            configure_gc(None)
            setter.assert_not_called()
            configure_gc(10000)
            setter.assert_called_once_with(10000, 11, 12)

    def test_setting_bounds_and_compose_blank_value(self):
        with patch.dict("os.environ", {}, clear=True):
            self.assertIsNone(Settings().VISION_GC_GEN0_THRESHOLD)
            self.assertIsNone(Settings(VISION_GC_GEN0_THRESHOLD="").VISION_GC_GEN0_THRESHOLD)
            self.assertIsNone(Settings(VISION_GC_GEN0_THRESHOLD="  ").VISION_GC_GEN0_THRESHOLD)
            for value in (100, 10000, 1000000):
                self.assertEqual(Settings(VISION_GC_GEN0_THRESHOLD=value).VISION_GC_GEN0_THRESHOLD, value)
            for value in (99, 1000001):
                with self.assertRaises(ValidationError):
                    Settings(VISION_GC_GEN0_THRESHOLD=value)


class WorkerGCFreezeTests(unittest.IsolatedAsyncioTestCase):
    async def test_startup_freezes_after_models_before_worker_tasks(self):
        from app import main

        events = []
        executor = Mock()

        def loaded(name, value):
            events.append(name)
            return value

        def worker(state):
            events.append("task")
            return asyncio.sleep(0)

        with patch("app.main.RecordingDetectionWriter", return_value=Mock(enabled=False)), patch(
            "app.main.load_yolo_model", side_effect=lambda: loaded("yolo", Mock())
        ), patch("app.main.load_depth_estimator", side_effect=lambda: loaded("depth", Mock())), patch(
            "app.main.make_depth_executor", side_effect=lambda: loaded("executor", executor)
        ), patch("app.main.configure_gc", side_effect=lambda value: events.append("threshold")), patch(
            "app.main._freeze_loaded_objects", side_effect=lambda label: events.append("freeze")
        ), patch("app.main.frame_receiver", new=worker), patch(
            "app.main.yolo_worker", new=worker
        ), patch("app.main.metrics_worker", new=worker), patch(
            "app.main.sync_android_live_from_relay", new=worker
        ):
            async with main.lifespan(SimpleNamespace(state=SimpleNamespace())):
                self.assertEqual(events[:5], ["yolo", "depth", "executor", "threshold", "freeze"])
                self.assertEqual(events[5:], ["task"] * 4)
        executor.shutdown.assert_called_once_with(wait=True, cancel_futures=True)

    async def test_freezes_once_after_30_completed_results(self):
        state = AppState(current_epoch=1, tracker_epoch=1)
        state.inference_queue = asyncio.Queue()
        for seq in range(61):
            state.inference_queue.put_nowait(InferenceFrame(
                epoch=1, seq=seq, frame=None, pts=seq, time_base=1 / 90000,
                media_time=seq / 30,
            ))
        frozen_at = []
        completed = asyncio.Event()
        result = {"items": [], "width": 1, "height": 1, "inference_ms": 1.0}

        def infer(frame, **kwargs):
            return result

        original_put = state.put_result

        def put(item):
            original_put(item)
            if item.seq == 60:
                completed.set()

        state.put_result = put
        with patch("app.services.yolo.settings.YOLO_FRAME_DROP_POLICY", "queue"), patch(
            "app.services.yolo.run_yolo", side_effect=infer
        ), patch("app.services.yolo._freeze_loaded_objects", side_effect=lambda label: frozen_at.append(
            (label, state.metrics.frames_inferred, len(state.result_store))
        )), patch("app.services.yolo.print"):
            task = asyncio.create_task(yolo_worker(state))
            try:
                await asyncio.wait_for(completed.wait(), 5)
            finally:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task
        self.assertEqual(frozen_at, [("30 Vision inferences", 30, 30)])
        self.assertEqual(state.metrics.frames_inferred, 61)


if __name__ == "__main__":
    unittest.main()
