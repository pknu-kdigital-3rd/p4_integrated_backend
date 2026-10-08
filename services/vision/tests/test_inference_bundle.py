import json
import os
from pathlib import Path
from fractions import Fraction
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest

import av

from preprocess_video import create_bundle
from app.services.inference_bundle import InferenceBundle


def synthetic_video(path):
    with av.open(str(path), 'w') as output:
        stream = output.add_stream('libx264', rate=30)
        stream.width, stream.height, stream.pix_fmt = 64, 48, 'yuv420p'
        stream.time_base = stream.codec_context.time_base = Fraction(1, 90000)
        stream.options = {'bf': '0', 'profile': 'baseline'}
        for pts in [90000, 93000, 99000, 102000, 108000]:
            frame = av.VideoFrame(64, 48, 'yuv420p')
            for plane in frame.planes:
                plane.update(bytes([100]) * plane.buffer_size)
            frame.pts, frame.time_base = pts, Fraction(1, 90000)
            for packet in stream.encode(frame):
                output.mux(packet)
        for packet in stream.encode():
            output.mux(packet)


def fake_infer(frame):
    return {'width': frame.frame.width, 'height': frame.frame.height,
            'items': [] if frame.seq == 1 else [
                {'class': 'car', 'confidence': 0.9, 'bbox': [0.1, 0.2, 0.8, 0.9],
                 'bbox_format': 'xyxy_normalized', 'track_id': 7,
                 'mask': [[0.1, 0.2], [0.8, 0.2], [0.8, 0.9]],
                 'mask_format': 'polygon_normalized', 'distance_m': frame.pts / 90000 + 10,
                 'distance_status': 'ok'}],
            'depth': {'status': 'ok'}, 'inference_ms': 12}


class InferenceBundleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.video = self.root / 'base.mp4'
        synthetic_video(self.video)
        self.output = self.root / 'precomputed'

    def generate(self, infer=fake_infer):
        return create_bundle(self.video, self.output, infer, {
            'model_filename': 'fixture.pt', 'overlay_classes': ['car'],
            'confidence_thresholds': {'appear': 0.5, 'keep': 0.1},
        })

    def test_every_frame_and_variable_timing_round_trip(self):
        calls = []
        def infer(frame):
            calls.append(frame.pts)
            return fake_infer(frame)
        self.generate(infer)
        bundle = InferenceBundle(self.output)
        self.assertEqual(calls, [0, 3000, 9000, 12000, 18000])
        self.assertEqual(bundle.timestamps, calls)
        self.assertEqual(bundle.result_at(3000)['items'], [])
        self.assertEqual(bundle.result_at(9000)['items'][0]['track_id'], 7)
        self.assertEqual(bundle.result_at(9000)['items'][0]['mask_format'], 'polygon_normalized')
        self.assertAlmostEqual(bundle.result_at(9000)['items'][0]['distance_m'], 10.1)
        with self.assertRaisesRegex(ValueError, 'No saved inference'):
            bundle.result_at(4500)
        page = (self.output / 'review.html').read_text(encoding='utf-8')
        self.assertNotIn('INLINE:', page)
        self.assertNotIn('<script src=', page)
        self.assertIn('requestVideoFrameCallback', page)
        with self.assertRaisesRegex(ValueError, 'already exists'):
            self.generate()

    def test_failure_does_not_publish_partial_bundle(self):
        def fail(frame):
            if frame.seq == 2:
                raise RuntimeError('model failed')
            return fake_infer(frame)
        with self.assertRaisesRegex(RuntimeError, 'model failed'):
            self.generate(fail)
        self.assertFalse(self.output.exists())
        self.assertEqual(list(self.root.glob('.vision-precompute-*')), [])

    def test_depth_failure_is_not_a_complete_bundle(self):
        def bad_depth(frame):
            return dict(fake_infer(frame), depth={'status': 'error'})
        with self.assertRaisesRegex(RuntimeError, 'Depth execution failed'):
            self.generate(bad_depth)
        self.assertFalse(self.output.exists())

    def test_corruption_incomplete_and_invalid_index_rejected(self):
        self.generate()
        manifest_path = self.output / 'manifest.json'
        original = json.loads(manifest_path.read_text())
        for manifest in (dict(original, complete=False), dict(original, version=999),
                         dict(original, frames=[[0, 0, 1]])):
            manifest_path.write_text(json.dumps(manifest))
            with self.assertRaises(ValueError):
                InferenceBundle(self.output)
        manifest_path.write_text(json.dumps(original))
        with (self.output / 'playback.mp4').open('ab') as stream:
            stream.write(b'corruption')
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            InferenceBundle(self.output)

    def test_cached_source_offset_is_applied_once_and_original_video_is_unneeded(self):
        from app.services.server_source import ServerSource
        self.generate()
        manifest_path = self.output / 'manifest.json'
        manifest = json.loads(manifest_path.read_text())
        manifest['source_time_offset_ns'] = '100000000'
        manifest_path.write_text(json.dumps(manifest))
        (self.root / 'gps.csv').write_text('timestamp_ns,latitude,longitude\n1000000000,35,129\n2000000000,35.001,129.001\n')
        (self.root / 'imu.csv').write_text('timestamp_ns,pitch_deg,roll_deg,yaw_deg\n1000000000,0,0,0\n2000000000,0,0,0\n')
        config = SimpleNamespace(SERVER_DATASET_DIR=str(self.root), SERVER_VIDEO_FILE='missing-original.mp4',
                                 SERVER_GPS_FILE='gps.csv', SERVER_IMU_FILE='imu.csv',
                                 SERVER_SOURCE_START_NS=2000000000, SERVER_VEHICLE_ID='server',
                                 VISION_INFERENCE_MODE='cached', VISION_CACHE_DIR=str(self.output))
        source = ServerSource(config)
        source.load()
        self.assertEqual(source.start_ns, 2100000000)
        source.load()
        self.assertEqual(source.start_ns, 2100000000)
        self.assertEqual(source.video, self.output / 'playback.mp4')

    def test_cached_websocket_without_any_inference_imports(self):
        self.generate()
        (self.root / 'gps.csv').write_text('timestamp_ns,latitude,longitude\n1000000000,35,129\n2000000000,35.001,129.001\n')
        (self.root / 'imu.csv').write_text('timestamp_ns,pitch_deg,roll_deg,yaw_deg\n1000000000,0,0,0\n2000000000,0,0,0\n')
        # A fresh interpreter prevents prior tests/imports from hiding an
        # accidental model import. The actual application lifespan, receiver,
        # WebSocket serialization and H.264 decode run with these imports denied.
        script = r'''
import importlib.abc, sys, json, av
class DenyInference(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split('.')[0] in {'torch', 'torchvision', 'ultralytics', 'unidepth', 'xformers', 'tensorrt', 'cv2', 'numpy', 'aiortc'}:
            raise AssertionError('Inference import during cached playback: ' + fullname)
sys.meta_path.insert(0, DenyInference())
from fastapi.testclient import TestClient
from app.main import app
def receive_frame(ws):
    for _ in range(50):
        message = ws.receive()
        if message.get('bytes'):
            data = message['bytes']; size = int.from_bytes(data[:4], 'big')
            meta = json.loads(data[4:4+size])
            ws.send_json({'type':'presented','epoch':meta['epoch'],'seq':meta['seq']})
            return meta, data[4+size:]
        if message.get('text'):
            value = json.loads(message['text'])
            assert value.get('type') != 'fault', value
    raise AssertionError('No frame')
with TestClient(app) as client:
    assert client.get('/health/live').status_code == 200
    assert client.get('/live-view-overlay.js').status_code == 200
    with client.websocket_connect('/ws/playback') as ws:
        ws.send_json({'type':'open'})
        decoder = av.CodecContext.create('h264','r')
        first, encoded = receive_frame(ws)
        assert first['inference_mode'] == 'cached'
        assert first['model_filename'] == 'fixture.pt'
        assert first['confidence_thresholds']['appear'] == 0.5
        assert first['source']['time'] == 0
        assert first['telemetry']['gps']['latitude'] == 35
        assert first['inference']['items'][0]['distance_m'] == 10
        decoded = decoder.decode(av.Packet(encoded))
        assert len(decoded) == 1 and decoded[0].width == 64
        ws.send_json({'type':'seek','position':0.08})
        for _ in range(10):
            frame, encoded = receive_frame(ws)
            if frame['epoch'] != first['epoch']: break
        assert abs(frame['source']['time'] - 0.1) < 1e-8, frame
        assert abs(frame['inference']['items'][0]['distance_m'] - 10.1) < 1e-8
        ws.send_json({'type':'set_loop','start':0,'end':0.08})
        epoch = frame['epoch']
        for _ in range(10):
            frame, _ = receive_frame(ws)
            if frame['epoch'] != epoch: break
        assert frame['source']['time'] == 0
        frame, _ = receive_frame(ws)
        assert frame['inference']['items'] == []
        ws.send_json({'type':'stop'})
    with client.websocket_connect('/ws/playback') as ws:
        ws.send_json({'type':'open'})
        frame, _ = receive_frame(ws)
        assert frame['inference_mode'] == 'cached'
        ws.send_json({'type':'stop'})
assert not any(name in sys.modules for name in ('torch','ultralytics','unidepth','cv2','numpy'))
print('cached WebSocket, seek, loop, reconnect, GPS and H.264 decode verified without inference imports')
'''
        environment = dict(os.environ, VISION_INFERENCE_MODE='cached', VISION_SOURCE='server',
                           SERVER_DATASET_DIR=str(self.root), VISION_CACHE_DIR=str(self.output),
                           RECORDING_ENABLED='false', SERVER_SOURCE_START_NS='')
        result = subprocess.run([sys.executable, '-c', script], env=environment,
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
