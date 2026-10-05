"""Integration check: pip install lupa opencv-python qrcode; ffmpeg must be on PATH.

Runs the Lua script against an mpv API stub, renders its ASS drawing with libass
over a frame that carries a timestamp QR baked the way bake_timecode.py does,
and checks that the end marker replaces exactly that QR and nothing else.
"""
import subprocess, tempfile
from pathlib import Path

import cv2
import numpy as np
import qrcode
from lupa import LuaRuntime

QR_SIZE, MARGIN = 160, 12  # bake_timecode.py defaults

lua = LuaRuntime(unpack_returned_tuples=True)
lua.execute('''callbacks={}; events={}; props={}
ov={updates=0,removed=0,update=function(self) self.updates=self.updates+1 end, remove=function(self) self.removed=self.removed+1 end}
package.preload['mp']=function() return {
create_osd_overlay=function() return ov end,
get_property_native=function(name) return props[name] end,
observe_property=function(name,kind,fn) callbacks[name]=fn end,
register_event=function(name,fn) events[name]=fn end } end
package.preload['mp.options']=function() return { read_options=function() end } end
''')
lua.execute((Path(__file__).resolve().parents[1] / 'scripts/p4-replay-end.lua').read_text())
g = lua.globals()
workspace = tempfile.TemporaryDirectory(prefix='p4-mpv-test-', dir=Path.cwd())
output = Path(workspace.name)


def baked_patch(payload):
    # Same as bake_timecode.make_qr_patch.
    qr = qrcode.QRCode(border=2, box_size=4)
    qr.add_data(payload)
    qr.make(fit=True)
    img = np.array(qr.make_image(fill_color='black', back_color='white').convert('L'))
    return cv2.resize(img, (QR_SIZE, QR_SIZE), interpolation=cv2.INTER_NEAREST)


def window_frame(video_w, video_h, osd):
    """The window as mpv shows it: the baked video scaled into its rectangle, black bars around."""
    video = np.full((video_h, video_w), 90, np.uint8)
    x, y = (video_w - QR_SIZE) // 2, video_h - MARGIN - QR_SIZE
    video[y:y + QR_SIZE, x:x + QR_SIZE] = baked_patch('1727000000123456789')
    dw, dh = osd['w'] - osd['ml'] - osd['mr'], osd['h'] - osd['mt'] - osd['mb']
    frame = np.zeros((osd['h'], osd['w']), np.uint8)
    frame[osd['mt']:osd['mt'] + dh, osd['ml']:osd['ml'] + dw] = cv2.resize(video, (dw, dh), interpolation=cv2.INTER_AREA)
    sx, sy = dw / video_w, dh / video_h
    patch = (osd['ml'] + x * sx, osd['mt'] + y * sy, osd['ml'] + (x + QR_SIZE) * sx, osd['mt'] + (y + QR_SIZE) * sy)
    return cv2.cvtColor(frame, cv2.COLOR_GRAY2BGR), patch


def render(data, base, w, h):
    header = f'''[Script Info]
ScriptType: v4.00+
PlayResX: {w}
PlayResY: {h}
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
'''
    (output / 'marker.ass').write_text(header + ''.join(
        'Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,' + line + '\n' for line in data.splitlines()), encoding='utf-8')
    cv2.imwrite(str(output / 'base.png'), base)
    subprocess.run(['ffmpeg', '-v', 'error', '-i', 'base.png', '-vf', 'ass=marker.ass', '-frames:v', '1', '-y', 'out.png'],
                   check=True, cwd=output)
    return cv2.imread(str(output / 'out.png'))


def osd(w, h, ml=0, mt=0, mr=0, mb=0):
    return {'w': w, 'h': h, 'ml': ml, 'mt': mt, 'mr': mr, 'mb': mb}


assert g.ov.updates == 0
g.callbacks['eof-reached']('eof-reached', False)
assert g.ov.updates == 0
cases = [
    ((1920, 1080), osd(1920, 1080)),                    # fullscreen, 1:1
    ((1920, 1080), osd(1280, 720)),                     # scaled-down window
    ((1920, 1080), osd(1280, 1024, mt=152, mb=152)),    # letterbox
    ((1920, 1080), osd(2560, 1080, ml=320, mr=320)),    # pillarbox
    ((1280, 720), osd(1920, 1080)),                     # scaled-up 720p video
]
for (vw, vh), dims in cases:
    g.props['video-params'] = lua.table_from({'w': vw, 'h': vh})
    g.props['osd-dimensions'] = lua.table_from(dims)
    g.callbacks['eof-reached']('eof-reached', True)
    base, (px1, py1, px2, py2) = window_frame(vw, vh, dims)
    out = render(g.ov.data, base, dims['w'], dims['h'])
    label = f'{vw}x{vh} video in {dims["w"]}x{dims["h"]} window'
    ok, decoded, _, _ = cv2.QRCodeDetector().detectAndDecodeMulti(out)
    assert ok and list(decoded) == ['P4_REPLAY_END_V1'], (label, decoded)
    # Nothing outside the baked QR patch may change (no white panel).
    outside = np.ones(out.shape[:2], bool)
    outside[max(0, int(py1) - 2):int(py2) + 3, max(0, int(px1) - 2):int(px2) + 3] = False
    assert not np.any(out[outside] != base[outside]), (label, 'pixels changed outside the QR patch')
    # The old timestamp QR is fully replaced: every patch pixel is marker black or white.
    inside = out[int(py1) + 1:int(py2) - 1, int(px1) + 1:int(px2) - 1, 0]
    assert np.all((inside < 30) | (inside > 225)), (label, 'old QR shows through')
    print(f'End marker replaces only the baked QR: {label}')
    before = g.ov.updates
    g.callbacks['osd-dimensions']('osd-dimensions', None)
    g.callbacks['video-params']('video-params', None)
    assert g.ov.updates == before + 2
    before = g.ov.removed
    g.callbacks['eof-reached']('eof-reached', False)
    assert g.ov.removed == before + 1
before = g.ov.removed
g.events['file-loaded']()
assert g.ov.removed == before + 1
g.callbacks['osd-dimensions']('osd-dimensions', None)
assert g.callbacks['pause'] is None
print('EOF, seek-clear, new-file, resize and no-pause-trigger checks passed')

workspace.cleanup()
