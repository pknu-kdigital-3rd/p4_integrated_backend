# Live decoding and scheduling

The offline TensorRT comparison excludes decoding, relay ingest, playback and
event-loop scheduling. A fast comparison therefore does not explain live drops.
Previously H.264 packet decoding ran synchronously on the asyncio event loop;
even native code that releases the GIL prevents that loop from handling model
completion or playback until decode returns.

Live decoding now uses one persistent `vision-decode` worker per relay session.
Context creation, packet decode, epoch resets and end-of-stream flush run on that
same worker. Each call is awaited before reading the next record, preserving
packet order and bounding outstanding work to one decode. The existing metadata
matching, drop policy, resync behavior and source timeline remain in the loop.
No image array conversion or extra image copy is added by this handoff. Session
cleanup drains native work and releases the context before joining the worker.

The periodic `[live-scheduling]` line reports interval means:

| Field | Meaning |
|---|---|
| `decode_call_ms` | Wall time inside a native decode call, including flush and failed calls |
| `decode_wait_ms` | Awaited duration including worker dispatch and loop resumption |
| `decode_thread_cpu_ms` | Calling decoder worker CPU; excludes FFmpeg's other native worker threads |
| `inference_dispatch_ms` | Submission to start of inference in the default thread pool |
| `inference_resume_ms` | Inference returning/raising to the asyncio task resuming |
| `frame_age_ms` | Inference queue insertion to first inference submission, including tracker reset/fault wait |

Inference timing counts completed attempts, including failures. Cancellation
with native work still running does not record partial measurements. Frame age
counts selected frames on their first attempt; dropped frames are not included.
Existing `queue_wait_ms` is worker idle time awaiting a queue item, rather than
frame age. Existing `thread_gap_ms` also includes call-wrapper and rounding
differences; the new fields measure the actual boundaries separately.

Replay the same live scene with the same GPUs, model settings and browser
connection. Compare `infer_fps`, `skipped_fps`, and the new scheduling fields.
High resume delay means completion is waiting for the event loop; high dispatch
delay means worker scheduling is waiting. Decode handoffs incur some overhead;
this change frees the event loop, but no live FPS or total CPU improvement is
claimed without deployment measurements. It does not add GPU decoding.

Dev mounts `services/vision` as a directory and runs Uvicorn with reload. These
changes are app Python files; the individually mounted entrypoint and build
inputs are unchanged. Production bakes app code into its image. Verify the
effective code and `[live-scheduling]` output inside the deployed container
before attributing results to this change.

Local checks include actual H.264 encode/decode pixel equivalence, ordered
reset/flush, decode-error resync, event-loop responsiveness, cancellation drain,
inference boundary accounting and the existing worker/benchmark tests. Full
GPU-backed live service measurements require the deployment environment.
