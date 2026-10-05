# GPS replay in mpv

Copy the contents of this directory (including `scripts/`) into `%APPDATA%\mpv\`.
For a portable installation, use `portable_config\` beside `mpv.exe` instead.
Merge the settings/key binding with any existing configuration. Restart mpv once after installing.

Install the updated Android app that recognizes `P4_REPLAY_END_V1`.
Play any timestamp-QR video normally. At EOF, the plugin draws an end-marker QR exactly
over the video's bottom-center timestamp QR, the same size and module grid, and changes
nothing else on screen. It follows the video's position in the window, including
letterbox and pillarbox bars. If the video was baked with a non-default `--qr-size` or
`--margin`, set the same values in `script-opts/p4-replay-end.conf`. Android consumes the remaining GPS records and reports completion
through the existing server API. No video patching or per-video configuration is needed.

The marker requires a numeric timestamp from the active trip's selected dataset first;
a marker left on screen cannot complete a newly assigned trip by itself.
Pausing in the middle does not display it. Home seeks to the start, resumes playback,
and clears the marker; opening another file also clears it. Create/assign the next trip
before replaying it.

The Lua plugin uses only mpv's built-in APIs and needs no additional packages.
The configuration disables looping and keeps the window open at EOF.
See [mpv's official manual](https://mpv.io/manual/stable/) for script loading and `eof-reached`.

Development check: install Python `lupa`, `opencv-python` and `qrcode`, put FFmpeg on PATH,
and run `python config/mpv/tests/check_replay_end.py`. This executes the Lua script
with an mpv API stub and renders the actual ASS drawing with libass over a frame
carrying a timestamp QR baked as `bake_timecode.py` does. At five window layouts it
checks that only the end marker decodes, that no pixel outside the QR patch changes,
and EOF/seek/new-file/resize behavior. These are test
requirements only; the installed mpv plugin needs none of them.
