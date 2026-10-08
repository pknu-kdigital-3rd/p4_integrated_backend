const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8').replace(/\r\n/g, '\n');
// These transport unit tests exercise relay behavior. Server-video globals
// are normally initialized by the full page, outside extracted functions.
const contextWithPageDefaults = values => vm.createContext({ serverMode: false, endSeq: null, ...values });
// Exercise the page's actual lifecycle functions with controlled transport,
// decoder, and clocks; no H.264 hardware or camera is needed for these races.
function functions(...names) {
  return names.map(name => {
    const start = html.indexOf(`  function ${name}(`);
    assert.ok(start >= 0, name);
    const end = html.indexOf('\n  }\n', start);
    assert.ok(end >= 0, name);
    return html.slice(start, end + 4);
  }).join('\n');
}

function lifecycle() {
  const calls = [];
  const context = contextWithPageDefaults({
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
  const context = contextWithPageDefaults({
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
  const context = contextWithPageDefaults({
    invalidateDecoder() {}, decoderGeneration: 1, decoder: null, playing: true,
    pending: new Map([[123, pair]]), known: new Set(['1:1']), decoding: true,
    bufferedSeconds: () => 0.5, MAX_LIVE_LAG_S: 0.25,
    pump: () => pumped++, playoutAnchor: { wall: 0, ts: 0 },
    VideoDecoder: class { constructor(options) { output = options.output; } configure() {} },
  });
  vm.runInContext(functions('configureDecoder'), context);
  context.configureDecoder({});
  output({ timestamp: 123, close: () => closed++ });
  assert.equal(closed, 1);
  assert.equal(pumped, 1);
  assert.equal(context.pending.size, 0);
  assert.equal(context.known.size, 0);
  assert.equal(context.playoutAnchor, null);
});

test('queued live footage beyond the cap resets rather than draining stale frames', () => {
  let reset = 0;
  const context = contextWithPageDefaults({
    epoch: 1, known: new Set(), queue: [],
    bufferedSeconds: () => 0.8, MAX_QUEUED_LIVE_SECONDS: 0.75,
    MAX_QUEUED_LIVE_FRAMES: 30, maxBufferBytes: 1024, performance: { now: () => 0 },
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
  const context = contextWithPageDefaults({
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
    presentedCount: 0, awaitingPaint: 1, performance: { now: () => 100 },
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

function playout() {
  const context = contextWithPageDefaults({
    playoutAnchor: null, latePaints: 0,
    PLAYOUT_DELAY_MS: 50, PLAYOUT_REANCHOR_MS: 250, PLAYOUT_ADAPT: 0.1,
  });
  vm.runInContext(functions('playoutPaintAt'), context);
  return context;
}

test('playout schedule paints on source time after a fixed cushion', () => {
  const context = playout();
  assert.equal(context.playoutPaintAt({ timestamp_us: 0, receivedAt: 1000 }, 1005), 1050);
  assert.equal(context.playoutPaintAt({ timestamp_us: 33333, receivedAt: 1033 }, 1036), 1050 + 33.333);
  assert.equal(context.latePaints, 0);
});

test('a late frame paints at its slot without shifting the frames behind it', () => {
  const context = playout();
  context.playoutPaintAt({ timestamp_us: 0, receivedAt: 1000 }, 1000);
  // Frame 1 is due at 1083.3 but arrives at 1120: it is late, paints now.
  const late = context.playoutPaintAt({ timestamp_us: 33333, receivedAt: 1120 }, 1121);
  assert.ok(late < 1121);
  assert.equal(context.latePaints, 1);
  // Frame 2 arrived in the same burst; it stays near its original slot
  // (only the small adaptive nudge), so the backlog drains.
  const next = context.playoutPaintAt({ timestamp_us: 66667, receivedAt: 1121 }, 1122);
  assert.ok(Math.abs(next - (1050 + 66.667)) < 5, String(next));
});

test('a long stall or timestamp jump starts a new playout schedule', () => {
  for (const [timestamp_us, now] of [[33333, 2000], [-10_000_000, 1100], [10_000_000, 1100]]) {
    const context = playout();
    context.playoutPaintAt({ timestamp_us: 0, receivedAt: 1000 }, 1000);
    assert.equal(context.playoutPaintAt({ timestamp_us, receivedAt: now }, now), now + 50);
    assert.equal(context.playoutAnchor.ts, timestamp_us);
  }
});

test('decoder output frees the decoder for the next chunk while frames wait to paint', () => {
  let output, pumped = 0;
  const timers = [];
  const pair = { epoch: 1, seq: 1, timestamp_us: 0 };
  const context = contextWithPageDefaults({
    invalidateDecoder() {}, decoderGeneration: 1, decoder: null, playing: true,
    pending: new Map([[0, pair]]), known: new Set(), decoding: true, awaitingPaint: 0,
    bufferedSeconds: () => 0, MAX_LIVE_LAG_S: 0.25, performance: { now: () => 10 },
    playoutPaintAt: () => 60, pump: () => pumped++,
    setTimeout: (callback, delay) => timers.push(delay),
    VideoDecoder: class { constructor(options) { output = options.output; } configure() {} },
  });
  vm.runInContext(functions('configureDecoder'), context);
  context.configureDecoder({});
  output({ timestamp: 0, close() {} });
  assert.equal(context.decoding, false);
  assert.equal(context.awaitingPaint, 1);
  assert.equal(pumped, 1);
  assert.deepEqual(timers, [50]);
});

test('pump stops decoding ahead once enough frames wait for their slot', () => {
  const decoded = [];
  const context = contextWithPageDefaults({
    stopped: false, decoding: false, playing: true, awaitingPaint: 2, MAX_DECODED_AHEAD: 2,
    queue: [{ timestamp_us: 1, keyframe: false, data: new Uint8Array(1) }], pending: new Map(),
    decoder: { decode: chunk => decoded.push(chunk) }, performance: { now: () => 0 },
    EncodedVideoChunk: class { constructor(init) { Object.assign(this, init); } },
  });
  vm.runInContext(functions('pump'), context);
  context.pump();
  assert.equal(decoded.length, 0);
  context.awaitingPaint = 1;
  context.pump();
  assert.equal(decoded.length, 1);
});

// Cut at each function's own closing brace; top-level statements follow these.
function functionBodies(...names) {
  return names.map(name => {
    const start = html.indexOf(`  function ${name}(`);
    assert.ok(start >= 0, name);
    return html.slice(start, html.indexOf('\n  }\n', start) + 4);
  }).join('\n');
}

function distanceColoringPage(parentOrigin = 'https://operator.example') {
  const posted = [], saved = [];
  let synced = 0;
  const context = contextWithPageDefaults({
    parentOrigin,
    distanceColorSettings: { enabled: false, nearMaxM: 15, midMaxM: 40, colors: {} },
    distanceColors: { normalizeSettings: value => ({ ...value }) },
    syncDistanceColorControls: () => synced++,
    saveDistanceColorSettings: () => saved.push(context.distanceColorSettings.enabled),
    window: { parent: { postMessage: (message, origin) => posted.push({ message, origin }) } },
  });
  vm.runInContext(functionBodies('postDistanceColoring', 'setDistanceColoringEnabled'), context);
  return { context, posted, saved, synced: () => synced };
}

test('the operator overlay toggle switches distance coloring, saves it, and hears it back', () => {
  const { context, posted, saved, synced } = distanceColoringPage();
  context.setDistanceColoringEnabled(true);
  assert.equal(context.distanceColorSettings.enabled, true);
  assert.equal(context.distanceColorSettings.nearMaxM, 15);
  assert.deepEqual(saved, [true]);
  assert.equal(synced(), 1);
  assert.equal(JSON.stringify(posted), JSON.stringify([{ message: { type: 'live-view-distance-coloring', enabled: true }, origin: 'https://operator.example' }]));
  // Anything but true turns it off, as the message handler passes it through.
  context.setDistanceColoringEnabled('yes');
  assert.equal(context.distanceColorSettings.enabled, false);
});

test('a standalone Vision page does not report its coloring mode', () => {
  const { context, posted, saved } = distanceColoringPage(null);
  context.setDistanceColoringEnabled(true);
  assert.deepEqual(saved, [true]);
  assert.deepEqual(posted, []);
});

test('cached raw playback uses the shared saved-result renderer', () => {
  const calls = [];
  const context = contextWithPageDefaults({
    cachedPlayback: true, compensationMode: 'raw',
    window: { LiveViewOverlay: { draw: (...args) => calls.push(args) } },
    overlayCtx: {}, boxesEl: { checked: true }, masksEl: { checked: false },
    minConfidence: 0.3, distanceMultiplier: 1, distanceColors: {}, distanceColorSettings: {},
    classStyle: () => ({ box: true, mask: true }), classDisplayName: value => value,
  });
  vm.runInContext(functionBodies('drawOverlay'), context);
  const items = [{ class: 'car' }];
  context.drawOverlay({ items }, 1280, 720, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], items);
  assert.equal(calls[0][4].masks, false);
  assert.equal(calls[0][4].minConfidence, 0.3);
});
