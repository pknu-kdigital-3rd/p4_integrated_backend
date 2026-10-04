import json
from pathlib import Path
import shutil
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch
import uuid
import sys

import av
import numpy as np

from benchmark_trt_execution import compare, measure_frames, phase_order, read_frames, read_warmup_frames, run_worker, run_command, main


class TensorRTComparisonTests(unittest.TestCase):
    def test_child_output_streams_and_propagates_exit_code(self):
        with patch("builtins.print") as output:
            completed = run_command([sys.executable, "-c", "print('phase ready'); raise SystemExit(3)"])
        self.assertEqual(completed.returncode, 3)
        self.assertIn("phase ready", completed.stdout)
        self.assertTrue(output.called)

    def test_worker_rejects_async_fallback_before_measurement(self):
        args = SimpleNamespace(worker="async", video=Path("scene.mp4"), frames=1, start_frame=0, warmup=1)
        model = SimpleNamespace(predictor=SimpleNamespace(model=SimpleNamespace(
            backend=SimpleNamespace(_p4_async_execution=False)
        )))
        depth = SimpleNamespace(_compiled=True)
        with patch("benchmark_trt_execution.settings.YOLO_MODEL", "model.engine"), patch(
            "benchmark_trt_execution.settings.YOLO_DEVICE", "cuda:0"
        ), patch("benchmark_trt_execution.settings.YOLO_TRT_EXECUTION", "sync"), patch(
            "benchmark_trt_execution.settings.VISION_FRAME_PREP", "independent"
        ), patch("benchmark_trt_execution.settings.YOLO_PINNED_INPUT", False), patch(
            "benchmark_trt_execution.settings.VISION_CPU_PROFILE_FRAMES", 0
        ), patch("benchmark_trt_execution.read_warmup_frames", return_value=[object()]), patch(
            "benchmark_trt_execution.load_yolo_model", return_value=model
        ), patch("benchmark_trt_execution.load_depth_on_worker", new=AsyncMock(return_value=depth)), patch(
            "benchmark_trt_execution.run_yolo"
        ), patch("benchmark_trt_execution.measure_frames") as measure, patch("builtins.print"):
            with self.assertRaisesRegex(RuntimeError, "not active"):
                run_worker(args)
        measure.assert_not_called()

    def test_balanced_phase_order(self):
        self.assertEqual(phase_order(2), [(1, "sync"), (1, "async"), (2, "async"), (2, "sync")])

    def test_measurement_keeps_identical_frame_order_and_cpu_attribution(self):
        frames = [object(), object()]
        result = dict.fromkeys(("yolo_thread_cpu_ms", "depth_thread_cpu_ms", "frame_convert_thread_cpu_ms",
                               "postprocess_thread_cpu_ms", "model_ms", "depth_ms", "frame_convert_ms", "inference_ms"), 3.)
        result.update(depth={"status": "ok"}, model_timeline={"last_model": "depth"}, mask_count=2)
        infer = Mock(return_value=result)
        with patch("benchmark_trt_execution.perf_counter", side_effect=[1, 1.010, 2, 2.020]), patch(
            "benchmark_trt_execution.process_time", side_effect=[1, 1.005, 2, 2.015]
        ):
            report = measure_frames(iter(frames), infer)
        self.assertEqual([call.args[0] for call in infer.call_args_list], frames)
        self.assertAlmostEqual(report["wall_mean_ms"], 15)
        self.assertAlmostEqual(report["process_cpu_ms"], 10)
        self.assertEqual(report["yolo_thread_cpu_ms"], 3)
        self.assertEqual(report["last_model_counts"], {"depth": 2})
        result["depth"]["status"] = "inference_error"
        with self.assertRaisesRegex(RuntimeError, "depth inference failed"):
            measure_frames(frames, infer)

    def test_decode_time_is_excluded_and_empty_stream_rejected(self):
        clock = [0.]
        result = dict.fromkeys(("yolo_thread_cpu_ms", "depth_thread_cpu_ms", "frame_convert_thread_cpu_ms",
                               "postprocess_thread_cpu_ms", "model_ms", "depth_ms", "frame_convert_ms", "inference_ms"), 3.)
        result.update(depth={"status": "ok"}, model_timeline={"last_model": "depth"})
        def frames():
            for _ in range(3):
                clock[0] += 100  # simulated expensive decode before yielding
                yield object()
        def infer(frame):
            clock[0] += .01
            return result
        with patch("benchmark_trt_execution.perf_counter", side_effect=lambda: clock[0]):
            report = measure_frames(frames(), infer)
        self.assertEqual(report["frames"], 3)
        self.assertAlmostEqual(report["wall_mean_ms"], 10)
        with self.assertRaisesRegex(ValueError, "no video frames"):
            measure_frames(iter(()), infer)

    def test_cli_accepts_whole_video_and_large_explicit_counts(self):
        for count in (0, 1000):
            with patch("sys.argv", ["benchmark_trt_execution.py", "--video", "scene.mp4", "--frames", str(count)]), patch(
                "pathlib.Path.is_file", return_value=True
            ), patch("benchmark_trt_execution.compare") as compare_mock:
                main()
            self.assertEqual(compare_mock.call_args.args[0].frames, count)

    def test_comparison_uses_fresh_processes_and_rejects_failures(self):
        args = SimpleNamespace(video=Path("scene.mp4"), frames=2, warmup=1, start_frame=7,
                               rounds=2, output=None)
        report = dict.fromkeys(("wall_mean_ms", "wall_p99_ms", "yolo_thread_cpu_ms", "depth_thread_cpu_ms",
                               "frame_convert_thread_cpu_ms", "process_cpu_ms", "model_ms", "depth_ms", "mask_mean"), 1.)
        report["frames"] = 2
        modes = []
        def worker(command, **kwargs):
            mode = command[command.index("--worker") + 1]
            modes.append(mode)
            self.assertEqual(command[command.index("--start-frame") + 1], "7")
            self.assertEqual(command[command.index("--video") + 1], "scene.mp4")
            return SimpleNamespace(returncode=0, stdout="[trt-ab-result] " + json.dumps(dict(report, mode=mode)))
        with patch("benchmark_trt_execution.run_command", side_effect=worker), patch("builtins.print"):
            compare(args)
        self.assertEqual(modes, ["sync", "async", "async", "sync"])
        with patch("benchmark_trt_execution.run_command", return_value=SimpleNamespace(
            returncode=1, stdout="GPU failure"
        )), patch("builtins.print"):
            with self.assertRaisesRegex(RuntimeError, "no valid comparison"):
                compare(args)

    def test_native_video_decode_preserves_selected_scene_and_rejects_short_clip(self):
        workspace = Path(__file__).resolve().parents[3]
        folder = Path(__file__).resolve().parents[1] / "__pycache__" / f"trt-ab-{uuid.uuid4().hex}"
        self.assertTrue(folder.resolve().is_relative_to(workspace))
        folder.mkdir(parents=True)
        self.addCleanup(shutil.rmtree, folder)
        path = folder / "scene.mkv"
        with av.open(str(path), "w") as container:
            stream = container.add_stream("ffv1", rate=30)
            stream.width, stream.height, stream.pix_fmt = 32, 32, "yuv420p"
            for value in (0, 50, 100):
                frame = av.VideoFrame.from_ndarray(np.full((32, 32, 3), value, np.uint8), format="bgr24")
                for packet in stream.encode(frame):
                    container.mux(packet)
            for packet in stream.encode():
                container.mux(packet)
        frames = read_frames(path, 2, 1)
        self.assertEqual([frame.seq for frame in frames], [1, 2])
        self.assertEqual([(frame.frame.width, frame.frame.height) for frame in frames], [(32, 32)] * 2)
        self.assertLess(frames[0].frame.to_ndarray(format="bgr24").mean(),
                        frames[1].frame.to_ndarray(format="bgr24").mean())
        self.assertEqual([frame.seq for frame in read_frames(path, 0, 0)], [0, 1, 2])
        self.assertEqual([frame.seq for frame in read_frames(path, 0, 1)], [1, 2])
        self.assertEqual(len(read_warmup_frames(path, 30, 0)), 3)
        with self.assertRaisesRegex(ValueError, "found 2"):
            read_frames(path, 3, 1)


if __name__ == "__main__":
    unittest.main()
