"""Ordered decoder ownership and timing at the event-loop/thread boundary."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from time import perf_counter, thread_time

import av


async def timed_inference(function, frame, metrics):
    submitted = perf_counter()
    timing = {}

    def invoke():
        timing["start"] = perf_counter()
        try:
            return function(frame)
        finally:
            timing["end"] = perf_counter()

    try:
        return await asyncio.to_thread(invoke)
    finally:
        resumed = perf_counter()
        # Cancellation cannot stop native inference; don't read partial timing.
        if "end" in timing:
            metrics.inference_attempts += 1
            metrics.inference_dispatch_ms_total += (timing["start"] - submitted) * 1000
            metrics.inference_resume_ms_total += (resumed - timing["end"]) * 1000


class OrderedDecoder:
    """One session's H.264 context stays on one worker, including reset/flush."""

    def __init__(self, metrics, factory=None):
        self.metrics = metrics
        self.factory = factory or (lambda: av.CodecContext.create("h264", "r"))
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="vision-decode")
        self.context = None

    async def reset(self):
        def create():
            self.context = self.factory()
        await asyncio.get_running_loop().run_in_executor(self.executor, create)

    async def decode(self, packet=None):
        timing = {}
        submitted = perf_counter()

        def invoke():
            started, cpu = perf_counter(), thread_time()
            try:
                return self.context.decode(packet) if packet is not None else self.context.decode()
            finally:
                timing["wall"] = (perf_counter() - started) * 1000
                timing["cpu"] = (thread_time() - cpu) * 1000

        try:
            return await asyncio.get_running_loop().run_in_executor(self.executor, invoke)
        finally:
            if "wall" in timing:
                self.metrics.decode_calls += 1
                self.metrics.decode_ms_total += timing["wall"]
                self.metrics.decode_thread_cpu_ms_total += timing["cpu"]
                self.metrics.decode_wait_ms_total += (perf_counter() - submitted) * 1000

    async def run(self, function, *args):
        """Run per-frame work on the decode thread, behind earlier decodes."""
        return await asyncio.get_running_loop().run_in_executor(self.executor, function, *args)

    async def close(self):
        # Drain in-flight native decode before releasing its context, also on
        # cancellation. Joining the worker must not block the event loop.
        def release():
            self.context = None
        self.executor.submit(release)
        await asyncio.to_thread(self.executor.shutdown, wait=True, cancel_futures=False)
