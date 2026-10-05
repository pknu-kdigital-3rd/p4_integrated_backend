"""Integration check: pip install lupa opencv-python; ffmpeg must be on PATH."""
import subprocess,tempfile
from pathlib import Path
from lupa import LuaRuntime
import cv2
lua=LuaRuntime(unpack_returned_tuples=True)
lua.execute('''callbacks={}; events={}; width=1280; height=720
ov={updates=0,removed=0,update=function(self) self.updates=self.updates+1 end, remove=function(self) self.removed=self.removed+1 end}
package.preload['mp']=function() return {
create_osd_overlay=function() return ov end,
get_osd_size=function() return width,height,1 end,
observe_property=function(name,kind,fn) callbacks[name]=fn end,
register_event=function(name,fn) events[name]=fn end } end
''')
lua.execute((Path(__file__).resolve().parents[1] / 'scripts/p4-replay-end.lua').read_text())
workspace = tempfile.TemporaryDirectory(prefix='p4-mpv-test-', dir=Path.cwd())
output = Path(workspace.name)
g=lua.globals()
assert g.ov.updates==0
g.callbacks['eof-reached']('eof-reached',False)
assert g.ov.updates==0
for w,h in [(1280,720),(1920,1080),(640,360),(720,1280)]:
 g.width=w;g.height=h
 g.callbacks['eof-reached']('eof-reached',True)
 data=g.ov.data
 header=f'''[Script Info]
ScriptType: v4.00+
PlayResX: {w}
PlayResY: {h}
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
'''
 ass=output / 'marker.ass';png=output / f'marker-{w}-{h}.png'
 ass.write_text(header+''.join('Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,'+line+'\n' for line in data.splitlines()),encoding='utf-8')
 subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i',f'color=c=gray:s={w}x{h}','-vf','ass=marker.ass','-frames:v','1','-y',str(png)],check=True,cwd=output)
 decoded,_,_=cv2.QRCodeDetector().detectAndDecode(cv2.imread(str(png)))
 assert decoded=='P4_REPLAY_END_V1',(w,h,decoded,data[:90])
 print(f'Actual libass QR render decoded at {w}x{h}')
 before=g.ov.updates;g.width=w+100;g.callbacks['osd-dimensions']('osd-dimensions',None)
 assert g.ov.updates==before+1
 before=g.ov.removed;g.callbacks['eof-reached']('eof-reached',False)
 assert g.ov.removed==before+1
before=g.ov.removed;g.events['file-loaded']();assert g.ov.removed==before+1
g.callbacks['osd-dimensions']('osd-dimensions',None)
assert g.callbacks['pause'] is None
print('EOF, seek-clear, new-file, resize and no-pause-trigger checks passed')

workspace.cleanup()
