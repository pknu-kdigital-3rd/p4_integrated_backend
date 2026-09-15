import asyncio
from contextlib import suppress
import unittest
from unittest.mock import patch

from app.core.state import AppState, InferenceFrame, PlaybackItem
from app.services.inference import inference_worker


class PutResultTests(unittest.TestCase):
    """A stale result must never move the authoritative current epoch."""

    def test_storing_a_result_does_not_change_current_epoch(self):
        state = AppState()
        state.current_epoch = 2
        state.put_result(
            PlaybackItem(
                epoch=1,
                seq=0,
                encoded=b"",
                timestamp_us=0,
                keyframe=False,
                result={},
            )
        )
        self.assertEqual(state.current_epoch, 2)


class InferenceWorkerEpochRaceTests(unittest.IsolatedAsyncioTestCase):
    """Inference results from a superseded epoch must be discarded."""

    async def test_a_stale_result_is_discarded_not_stored(self):
        state = AppState()
        state.current_epoch = 1
        frame = InferenceFrame(
            seq=0,
            frame=None,
            pts=0,
            time_base=1 / 90000,
            media_time=0.0,
            epoch=1,
            timestamp_us=0,
        )
        await state.inference_queue.put(frame)

        def fake_run_inference(inference_frame, model):
            state.current_epoch = 2
            return {"width": 1, "height": 1, "items": [], "inference_ms": 1.0}

        with patch("app.services.inference.run_inference", side_effect=fake_run_inference):
            task = asyncio.create_task(inference_worker(state))
            for _ in range(100):
                await asyncio.sleep(0)
                if state.result_store or state.current_epoch != 1:
                    break
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

        self.assertEqual(state.current_epoch, 2)
        self.assertEqual(state.result_store, {})


if __name__ == "__main__":
    unittest.main()
