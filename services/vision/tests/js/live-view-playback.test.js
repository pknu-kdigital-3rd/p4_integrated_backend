const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
// Exercise the page's actual lifecycle functions with controlled transport,
// decoder, and clocks; no H.264 hardware or camera is needed for these races.
function functions(...names) {
  return names.map(name => {
    const start = html.indexOf(`  function ${name}(`);
    assert.ok(start >= 0, name);
    const end = html.indexOf('\n  function ', start + 1);
    return html.slice(start, end);
  }).join('\n');
}

function lifecycle() {
  const calls = [];
  const context = vm.createContext({
    stopped: false, decoding: false, foregroundResumePending: false, foregroundReconnectAttempts: 0,
    lastForegroundResumeAt: -Infinity, foregroundResumeTimer: null,
    socket: { readyState: 1, close: () => calls.push('close') }, reconnectTimer: null,
    WebSocket: { OPEN: 1, CONNECTING: 0 },
    performance: { now: () => 10000 }, document: { hidden: false },
    resetPlayback: () => calls.push('reset'), setLoading: () => calls.push('loading'),
    openSocket: () => calls.push('open'), clearTimeout() {},
    armForegroundResumeWatchdog: () => calls.push('watchdog'),
  });
  vm.runInContext(functions('reconnectAfterForegroundStall', 'reconnectAtLive', 'resumeAtLive'), context);
  return { context, calls };
}

test('foreground return immediately replaces the transport and coalesces duplicate signals', () => {
  const { context, calls } = lifecycle();
  context.resumeAtLive();
  assert.deepEqual(calls, ['reset', 'loading', 'close', 'open', 'watchdog']);
  context.resumeAtLive();
  assert.equal(calls.length, 5);
});

test('returning after a long background wait restarts a pending join', () => {
  const { context, calls } = lifecycle();
  context.foregroundResumePending = true;
  context.lastForegroundResumeAt = 0;
  context.resumeAtLive();
  assert.ok(calls.includes('open'));
});

test('watchdog keeps an open socket while waiting for a restarted publisher', () => {
  const { context, calls } = lifecycle();
  context.foregroundResumePending = true;
  context.foregroundReconnectAttempts = 2;
  context.reconnectAfterForegroundStall();
  assert.deepEqual(calls, ['loading', 'watchdog']);
  assert.equal(context.foregroundReconnectAttempts, 2);
});

test('a stream that stops delivering packets resyncs without reopening the transport', () => {
  let reconnects = 0;
  const context = vm.createContext({
    stopped: false, playing: true, decoding: false, document: { hidden: false },
    lastPaintedAt: 1000, performance: { now: () => 4100 }, DECODE_STALL_MS: 3000,
    jumpLive: () => reconnects++,
  });
  vm.runInContext(functions('checkPlaybackHealth'), context);
  context.checkPlaybackHealth();
  assert.equal(reconnects, 1);
  context.document.hidden = true;
  context.checkPlaybackHealth();
  assert.equal(reconnects, 1);
});

test('decoder skips stale rendering while preserving H.264 decode dependencies', () => {
  let output, closed = 0, pumped = 0;
  const pair = { epoch: 1, seq: 1 };
  const context = vm.createContext({
    invalidateDecoder() {}, decoderGeneration: 1, decoder: null, playing: true,
    pending: new Map([[123, pair]]), known: new Set(['1:1']), decoding: true,
    bufferedSeconds: () => 0.5, MAX_LIVE_LAG_S: 0.25,
    pump: () => pumped++, nextPaintAt: 123,
    VideoDecoder: class { constructor(options) { output = options.output; } configure() {} },
  });
  vm.runInContext(functions('configureDecoder'), context);
  context.configureDecoder({});
  output({ timestamp: 123, close: () => closed++ });
  assert.equal(closed, 1);
  assert.equal(pumped, 1);
  assert.equal(context.pending.size, 0);
  assert.equal(context.known.size, 0);
  assert.equal(context.nextPaintAt, null);
});

test('queued live footage beyond the cap resets rather than draining stale frames', () => {
  let reset = 0;
  const context = vm.createContext({
    epoch: 1, known: new Set(), queue: [],
    bufferedSeconds: () => 0.8, MAX_QUEUED_LIVE_SECONDS: 0.75,
    MAX_QUEUED_LIVE_FRAMES: 30, maxBufferBytes: 1024,
    reconnectAtLive: () => reset++,
  });
  vm.runInContext(functions('enqueue'), context);
  context.enqueue({ epoch: 1, seq: 1, source: { timestamp_us: 1 }, encoded: { keyframe: true } }, new Uint8Array(1));
  assert.equal(reset, 1);
});

test('embedded layout is applied by the head script before the body loads', () => {
  const classes = [];
  const headScript = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(headScript, {
    URLSearchParams, location: { search: '?embedded=1&autostart=1' },
    document: { documentElement: { classList: { add: (...values) => classes.push(...values) } } },
  });
  assert.ok(classes.includes('operator-live-view-fullscreen'));
  assert.ok(classes.includes('operator-live-view-hide-fps'));
});

test('receiving an encoded packet keeps loading active until its frame is painted', () => {
  let watchdogCleared = 0, loadingCleared = 0;
  const context = vm.createContext({
    stopped: false, socket: null, location: { protocol: 'https:', host: 'example.test' },
    WebSocket: class {}, Uint8Array, DataView, TextDecoder,
    awaitingLiveEpoch: false, foregroundResumePending: true,
    foregroundReconnectAttempts: 1, enqueue() {},
    clearForegroundResumeTimer: () => watchdogCleared++,
    loadingEl: { hidden: false }, setLoading: loading => { if (!loading) loadingCleared++; },
    videoCanvas: { width: 1, height: 1 }, videoCtx: { drawImage() {} },
    resize() {}, estimateGlobalMotion() {}, drawOverlay() {}, updateBrowserFps() {},
    updateStats() {}, known: new Set(), sessionStorage: { setItem() {} },
    send() {}, renderTelemetry() {}, postPresentedTelemetry() {}, pump() {},
    presentedCount: 0, performance: { now: () => 100 },
  });
  vm.runInContext(functions('openSocket', 'paint'), context);
  context.openSocket();
  const meta = new TextEncoder().encode(JSON.stringify({ epoch: 1, seq: 0 }));
  const bytes = new Uint8Array(4 + meta.length);
  new DataView(bytes.buffer).setUint32(0, meta.length);
  bytes.set(meta, 4);
  context.socket.onmessage({ data: bytes.buffer });
  assert.equal(context.foregroundResumePending, true);
  assert.equal(watchdogCleared, 0);
  context.paint({ close() {} }, {
    epoch: 1, seq: 0, timestamp_us: 0,
    frame: { width: 1, height: 1 }, inference: {},
  });
  assert.equal(context.foregroundResumePending, false);
  assert.equal(watchdogCleared, 1);
  assert.equal(loadingCleared, 1);
});

test('watchdog still replaces a failed transport', () => {
  const { context, calls } = lifecycle();
  context.socket = null;
  context.foregroundResumePending = true;
  context.reconnectAfterForegroundStall();
  assert.ok(calls.includes('open'));
  assert.equal(context.foregroundReconnectAttempts, 1);
});

test('watchdog repairs a decoder stall without replacing an open socket', () => {
  const { context, calls } = lifecycle();
  context.foregroundResumePending = true;
  context.decoding = true;
  context.decodeStartedAt = 0;
  context.DECODE_STALL_MS = 3000;
  context.jumpLive = () => calls.push('resync');
  context.reconnectAfterForegroundStall();
  assert.deepEqual(calls, ['resync']);
});
