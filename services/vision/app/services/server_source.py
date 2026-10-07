"""Read server video and recorded telemetry without a publisher or relay."""
from __future__ import annotations

import asyncio
import csv
import math
from fractions import Fraction
from pathlib import Path
from time import monotonic

import av

from app.core.state import InferenceFrame
from app.services.telemetry import GpsSampleIn, ImuSampleIn, SessionTelemetry, TelemetryStore


def read_samples(path, model):
    # Android's CSV parser treats unavailable/non-finite optional numeric
    # readings as null. Keep required coordinates, angles and clocks strict.
    optional_fields = {name for name, field in model.model_fields.items() if not field.is_required()}
    samples = []
    with path.open(encoding="utf-8-sig", newline="") as stream:
        for row in csv.DictReader(stream):
            values = {k.strip(): v.strip() for k, v in row.items() if v and v.strip()}
            for name in optional_fields & values.keys():
                try:
                    available = math.isfinite(float(values[name]))
                except ValueError:
                    available = False
                if not available:
                    values[name] = None
            samples.append(model.model_validate(values))
    if not samples:
        raise ValueError(f"Telemetry file is empty: {path.name}")
    if any(a.timestamp_ns > b.timestamp_ns for a, b in zip(samples, samples[1:])):
        raise ValueError(f"Telemetry timestamps are not ascending: {path.name}")
    return samples


class ServerSource:
    def __init__(self, config):
        self.directory = Path(config.SERVER_DATASET_DIR)
        self.video = self.directory / config.SERVER_VIDEO_FILE
        self.gps_file = self.directory / config.SERVER_GPS_FILE
        self.imu_file = self.directory / config.SERVER_IMU_FILE
        self.start_ns = config.SERVER_SOURCE_START_NS
        self.duration = 0.0
        self.fps = 30.0
        self.position = 0.0
        self.loop = None
        self.ready = False
        self.end_seq = None
        self.telemetry = TelemetryStore()
        # Local playback identity is display-only; never persisted as a real trip.
        self.identity = {"tripId": None, "vehicleId": config.SERVER_VEHICLE_ID, "recordingSessionId": "server-dataset"}

    def load(self):
        gps = read_samples(self.gps_file, GpsSampleIn)
        imu = read_samples(self.imu_file, ImuSampleIn)
        self.start_ns = self.start_ns or gps[0].timestamp_ns
        session = SessionTelemetry(None, self.identity["vehicleId"], "REPLAY",
                                   [s.timestamp_ns for s in gps], gps,
                                   [s.timestamp_ns for s in imu], imu)
        self.telemetry._sessions["server-dataset"] = session
        with av.open(str(self.video)) as container:
            stream = container.streams.video[0]
            self.fps = float(stream.average_rate or 30)
            self.duration = float(stream.duration * stream.time_base) if stream.duration else float(container.duration or 0) / av.time_base
        if self.duration <= 0:
            raise ValueError("Server video must have a known positive duration")
        self.ready = True

    def status(self):
        return {"mode": "server", "ready": self.ready, "duration": self.duration,
                "position": self.position, "loop": self.loop, "video": self.video.name,
                "end_seq": self.end_seq, "fps": self.fps}

    def seek(self, value):
        position = float(value)
        if not self.ready or not math.isfinite(position) or not 0 <= position < self.duration:
            raise ValueError("Seek must be within the loaded video duration")
        return position

    def set_loop(self, start, end):
        start, end = float(start), float(end)
        if not self.ready or not all(map(math.isfinite, (start, end))) or not 0 <= start < end <= self.duration:
            raise ValueError("Loop requires 0 <= start < end <= video duration")
        self.loop = [start, end]

    def frames(self, position):
        with av.open(str(self.video)) as container:
            stream = container.streams.video[0]
            origin = float((stream.start_time or 0) * stream.time_base)
            container.seek(int((position + origin) / stream.time_base), stream=stream)
            encoder = av.CodecContext.create("libx264", "w")
            encoder.width, encoder.height = stream.width, stream.height
            encoder.pix_fmt = "yuv420p"
            encoder.time_base = Fraction(1, 90000)
            encoder.options = {"preset": "ultrafast", "tune": "zerolatency", "profile": "baseline", "bf": "0", "g": "30"}
            for frame in container.decode(stream):
                seconds = float(frame.pts * frame.time_base) - origin
                if seconds < position:
                    continue
                frame = frame.reformat(format="yuv420p")
                frame.pts, frame.time_base = round(seconds * 90000), Fraction(1, 90000)
                packets = encoder.encode(frame)
                if packets:
                    yield seconds, frame, b"".join(bytes(p) for p in packets), packets[0].is_keyframe


def next_frame(iterator):
    return next(iterator, None)


async def server_frame_receiver(state):
    from app.services.yolo import _discard_inference_queue, _enqueue_inference_frame, _schedule_playback_deadline
    from time import perf_counter

    source = state.server_source
    iterator = None
    seq = 0
    active = False
    pending_seek = 0.0
    pending_item = None
    anchor_time = None
    anchor_position = 0.0
    try:
        while True:
            command = None
            try:
                command = state.feed_commands.get_nowait()
            except asyncio.QueueEmpty:
                pass
            if command and command["type"] == "stop":
                active = False
            if command and command["type"] in {"seek", "resync", "jump_to_live"}:
                try:
                    if not source.ready:
                        await asyncio.to_thread(source.load)
                    if command["type"] == "seek":
                        pending_seek = source.seek(command["position"])
                    else:
                        pending_seek = 0.0 if source.end_seq is not None else min(source.position, max(0, source.duration - 0.1))
                    if iterator is not None:
                        await asyncio.to_thread(iterator.close)
                    iterator = source.frames(pending_seek)
                    pending_item = None
                    anchor_time = None
                    async with state.result_condition:
                        state.current_epoch += 1
                        state.playback_reset_generation += 1
                        state.clear_all_results()
                        state.clear_completed_sequences()
                        state.queued_sequences.clear()
                        _discard_inference_queue(state)
                        state.last_presented = None
                        state.fault = None
                        state.result_condition.notify_all()
                    source.end_seq = None
                    seq, active = 0, True
                except Exception as exc:
                    state.fault = f"Server dataset: {exc}"
                    active = False
                    # Complete the reset handshake even on a load failure.
                    async with state.result_condition:
                        state.playback_reset_generation += 1
                        state.result_condition.notify_all()
            if not active or not state.viewer_connected or len(state.result_store) >= 30:
                await asyncio.sleep(0.02)
                continue
            try:
                if pending_item is None:
                    pending_item = await asyncio.to_thread(next_frame, iterator)
                item = pending_item
                if item is None:
                    source.end_seq = seq - 1
                    active = False
                    continue
                seconds, frame, encoded, keyframe = item
                # Stop prefetch at the loop endpoint; the browser seeks when
                # its presented frame reaches the last frame in the interval.
                if source.loop and seconds >= source.loop[1]:
                    source.end_seq = seq - 1
                    active = False
                    continue
                # Decode/encode one frame ahead, then emit on the source clock.
                # Sleeping a full frame period AFTER processing accumulates
                # decode/encode cost and slows a 25 FPS file below real time.
                now = monotonic()
                if anchor_time is None:
                    anchor_time, anchor_position = now, seconds
                delay = anchor_time + seconds - anchor_position - now
                if delay > 0:
                    # Return to the command loop regularly so seek/stop can
                    # interrupt the wait, including long source timestamp gaps.
                    await asyncio.sleep(min(0.02, delay))
                    continue
                pending_item = None
                source.position = seconds
                inference_frame = InferenceFrame(
                    seq=seq, frame=frame, pts=round(seconds * 90000), time_base=1 / 90000,
                    media_time=seconds, epoch=state.current_epoch, encoded=encoded,
                    timestamp_us=round(seconds * 1_000_000), keyframe=keyframe,
                    resolved_source_timestamp_ns=source.start_ns + round(seconds * 1_000_000_000),
                    source_timeline_status="server", recording_identity=source.identity)
                state.queued_sequences.add((state.current_epoch, seq))
                state.metrics.decoded_frames_received += 1
                await _enqueue_inference_frame(state, inference_frame)
                _schedule_playback_deadline(state, inference_frame, perf_counter())
                seq += 1
                await asyncio.sleep(0)
            except Exception as exc:
                active = False
                async with state.result_condition:
                    state.fault = f"Server video decode: {exc}"
                    state.result_condition.notify_all()
    finally:
        if iterator is not None:
            await asyncio.to_thread(iterator.close)
