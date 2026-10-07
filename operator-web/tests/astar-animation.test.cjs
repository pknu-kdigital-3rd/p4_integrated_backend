const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({ performance: { now: () => 0 } });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../astar-animation.js'), 'utf8').replaceAll('export function', 'function'), context);
const trace = { edges: { a: [[129, 35], [129.001, 35]] }, events: [
  { kind: 'discovered', edgeId: 'a' }, { kind: 'expanded', edgeId: 'a' }, { kind: 'discovered', edgeId: 'a' },
] };
const route = { coordinates: [[129, 35], [129.001, 35]] };
test('exploration precedes final route and expanded roads remain expanded', () => {
  const replay = context.createSearchReplay(trace, route);
  assert.equal(replay.advance(10000).edges.get('a'), 'discovered');
  let state = replay.advance(10000);
  assert.equal(state.edges.get('a'), 'expanded');
  assert.equal(state.routeProgress, 0);
  state = replay.advance(2500);
  assert.equal(state.routeProgress, 0.5);
  assert.equal(replay.advance(2500).done, true);
});
test('trace processing is bounded per frame and never draws the final route early', () => {
  const replay = context.createSearchReplay({ ...trace, events: Array(100).fill(trace.events[0]) }, route);
  let time = 0;
  const state = replay.advance(10000, () => time++);
  assert.ok(state.index < 100);
  assert.equal(state.routeProgress, 0);
  let next;
  do { next = replay.advance(100, () => 0); } while (!next.done);
  assert.equal(next.index, 100);
});
test('reduced motion displays the complete trace and final route immediately', () => {
  const state = context.createSearchReplay(trace, route, true).advance(0);
  assert.equal(state.done, true);
  assert.equal(state.routeProgress, 1);
  assert.equal(state.index, 3);
});
test('an unreachable destination can replay exploration without a final route', () => {
  const state = context.createSearchReplay(trace, undefined, true).advance(0);
  assert.equal(state.hasRoute, false);
  assert.equal(state.done, true);
});

test('a late cancelled search cannot overwrite or stop a newer animation request', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../virtual-dispatch.js'), 'utf8');
  const start = source.indexOf('async function showAstarAnimation()');
  const end = source.indexOf('\n}', start) + 2;
  const responses = []; let plays = 0, stops = 0;
  const cachedResults = new Map();
  const fixture = vm.createContext({ AbortController,
    astarShow: { disabled: false }, astarPlayback: {}, astarPause: {}, astarStatus: {},
    document: { querySelector: () => ({}) }, scenarioId: '1', scenarioRevision: 2, draft: { draftId: '4' },
    astarController: null, astarKey: '', astarResult: null,
    astarContextKey: () => 'current', syncSearchCache: () => cachedResults,
    syncAstarButton() {}, setStatus() {}, setInterval: () => 1,
    api: () => new Promise(resolve => responses.push(resolve)),
    playAstarResult: () => { plays++; }, stopAstarAnimation: () => { stops++; },
  });
  vm.runInContext(source.slice(start, end), fixture);
  const old = fixture.showAstarAnimation(); fixture.astarController.abort();
  const newer = fixture.showAstarAnimation(); const controller = fixture.astarController;
  responses[0]({ marker: 'old' }); await old;
  assert.equal(fixture.astarResult, null); assert.equal(fixture.astarController, controller);
  assert.equal(stops, 0); assert.equal(plays, 0);
  assert.equal(cachedResults.size, 0);
  responses[1]({ marker: 'new' }); await newer;
  assert.equal(fixture.astarResult.marker, 'new'); assert.equal(plays, 1);
});

test('stop, pause, hidden-page resume, and invalidation clean up animation resources', () => {
  const callbacks = new Map(), listeners = new Map(), draws = [];
  let nextFrame = 0, current = true, removed = 0;
  const ctx = { setTransform() {}, clearRect() {}, drawImage() {}, beginPath() {}, moveTo(x, y) { draws.push([x, y]); }, lineTo() {}, stroke() {} };
  const canvas = { style: {}, setAttribute() {}, getContext: () => ctx, remove() { removed++; } };
  const doc = { hidden: false, createElement: () => canvas,
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const point = (x, y) => ({ x, y, distanceTo(b) { return Math.hypot(x - b.x, y - b.y); } });
  const mapListeners = new Set();
  const map = { getZoom: () => 10, project: ([lat, lon]) => point(lon * 100, lat * 100),
    getSize: () => ({ x: 640, y: 480 }), latLngToContainerPoint: ([lat, lon]) => point(lon * 100, lat * 100),
    getContainer: () => ({ append() {} }), on: (_, fn) => mapListeners.add(fn), off: (_, fn) => mapListeners.delete(fn) };
  const env = vm.createContext({ document: doc, performance: { now: () => 0 },
    window: { devicePixelRatio: 1, matchMedia: () => ({ matches: false }) },
    requestAnimationFrame: fn => { callbacks.set(++nextFrame, fn); return nextFrame; },
    cancelAnimationFrame: id => callbacks.delete(id) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../astar-animation.js'), 'utf8').replaceAll('export function', 'function'), env);
  let invalidated = false;
  const animation = env.installSearchAnimation(map, { onProgress() {}, onDone: completed => { invalidated = !completed; }, isCurrent: () => current });
  animation.start({ searchTrace: trace, routeGeojson: route });
  animation.pause(true); assert.equal(callbacks.size, 0);
  animation.pause(false); assert.equal(callbacks.size, 1);
  function tick(time) { const [id, fn] = callbacks.entries().next().value; callbacks.delete(id); fn(time); }
  tick(0); tick(4000);
  doc.hidden = true; tick(5000); assert.equal(callbacks.size, 0);
  doc.hidden = false; listeners.get('visibilitychange')(); assert.equal(callbacks.size, 1);
  current = false; tick(6000);
  assert.equal(invalidated, true); assert.equal(mapListeners.size, 0); assert.equal(listeners.size, 0);
  assert.ok(removed >= 2);
  animation.stop(); assert.equal(callbacks.size, 0);
});

function animationFixture(reducedMotion = false) {
  const callbacks = new Map(), handlers = new Map(), progress = [], draws = [];
  let frameId = 0, zoom = 1, offset = { x: 0, y: 0 }, completed = 0, segments = 0, clears = 0;
  const point = (x, y) => ({ x, y, distanceTo(b) { return Math.hypot(x - b.x, y - b.y); } });
  const project = ([lat, lon]) => point(lon * 2 ** zoom, lat * 2 ** zoom);
  const canvas = { style: {}, setAttribute() {}, remove() {}, getContext: () => ({
    setTransform() {}, clearRect() { clears++; }, drawImage() {}, beginPath() {},
    moveTo(x, y) { draws.push([x, y]); }, lineTo() { segments++; }, stroke() {},
  }) };
  const map = { getZoom: () => zoom, project,
    latLngToContainerPoint: coords => { const p = project(coords); return point(p.x - offset.x, p.y - offset.y); },
    getSize: () => ({ x: 640, y: 480 }), getContainer: () => ({ append() {} }),
    on: (names, fn) => names.split(' ').forEach(name => handlers.set(name, fn)),
    off: names => names.split(' ').forEach(name => handlers.delete(name)),
  };
  const env = vm.createContext({ performance: { now: () => 0 },
    document: { hidden: false, createElement: () => canvas, addEventListener() {}, removeEventListener() {} },
    window: { devicePixelRatio: 1, matchMedia: () => ({ matches: reducedMotion }) },
    requestAnimationFrame: fn => { callbacks.set(++frameId, fn); return frameId; },
    cancelAnimationFrame: id => callbacks.delete(id),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../astar-animation.js'), 'utf8').replaceAll('export function', 'function'), env);
  const animation = env.installSearchAnimation(map, {
    onProgress: state => progress.push({ ...state }), onDone: () => completed++, isCurrent: () => true,
  });
  return { animation, canvas, progress, draws, handlers, callbacks,
    view(nextZoom, nextOffset) { zoom = nextZoom; offset = nextOffset; },
    completed: () => completed,
    segments: () => segments, clears: () => clears,
    tick(time) { const [id, fn] = callbacks.entries().next().value; callbacks.delete(id); fn(time); },
  };
}

test('large exploration draws new edges once rather than redrawing its growing history', () => {
  const edges = {}, events = [];
  for (let i = 0; i < 50000; i++) {
    const edgeId = String(i);
    edges[edgeId] = [[129, 35], [129.001, 35]];
    events.push({ kind: 'discovered', edgeId }, { kind: 'expanded', edgeId });
  }
  const f = animationFixture();
  f.animation.start({ searchTrace: { edges, events } });
  f.tick(0);
  for (let time = 100; time <= 20000; time += 100) f.tick(time);
  assert.equal(f.progress.at(-1).index, 100000);
  // Depending on frame boundaries, discovery and expansion may be painted
  // together or separately. Each edge must be painted at most twice.
  assert.ok(f.segments() >= 50000 && f.segments() <= 100000);
  const before = f.segments();
  for (let time = 20100; time <= 25000; time += 100) f.tick(time);
  assert.equal(f.segments(), before);
  assert.equal(f.completed(), 1);
  // Rebuild all visible geometry exactly once when a completed view is panned.
  f.view(1, { x: 10, y: 20 });
  f.handlers.get('move')();
  assert.equal(f.segments(), before + 50000);
  f.handlers.get('moveend')();
  assert.equal(f.segments(), before + 50000);
});

test('repeated discoveries cannot recolor expanded roads or add drawing work', () => {
  const f = animationFixture();
  f.animation.start({ searchTrace: trace });
  f.tick(0);
  for (let time = 100; time <= 14000; time += 100) f.tick(time);
  assert.equal(f.segments(), 2);
  for (let time = 14100; time <= 20000; time += 100) f.tick(time);
  assert.equal(f.segments(), 2);
  assert.equal(f.progress.at(-1).edges.get('a'), 'expanded');
  const before = f.clears();
  f.animation.start({ searchTrace: trace });
  assert.ok(f.clears() >= before + 3);
  assert.equal(f.progress.at(-1).edges.size, 0);
});

test('completed and paused animations restart, including an explicit reduced-motion replay', () => {
  const f = animationFixture(true), result = { searchTrace: trace, routeGeojson: route };
  f.animation.start(result);
  assert.equal(f.completed(), 1);
  assert.equal(f.callbacks.size, 0);
  f.animation.start(result, { animate: true });
  assert.equal(f.progress.at(-1).index, 0);
  assert.equal(f.progress.at(-1).routeProgress, 0);
  f.animation.setSpeed(2);
  f.tick(0);
  for (let time = 100; time <= 12500; time += 100) f.tick(time);
  assert.equal(f.completed(), 2);
  f.animation.start(result, { animate: true });
  f.animation.pause(true);
  assert.equal(f.callbacks.size, 0);
  f.animation.start(result, { animate: true });
  assert.equal(f.callbacks.size, 1);
  assert.equal(f.progress.at(-1).done, false);
});

test('zoom and pan realign a paused overlay without advancing playback', () => {
  const f = animationFixture(true);
  f.animation.start({ searchTrace: trace, routeGeojson: route });
  f.animation.pause(true);
  f.handlers.get('zoomstart')();
  assert.equal(f.canvas.style.visibility, 'hidden');
  f.view(2, { x: 40, y: 20 });
  const before = f.draws.length;
  f.handlers.get('move')();
  assert.equal(f.draws.length, before);
  f.handlers.get('zoomend')();
  assert.equal(f.canvas.style.visibility, '');
  assert.deepEqual(f.draws.at(-1), [129 * 4 - 40, 35 * 4 - 20]);
  f.view(2, { x: 50, y: 30 });
  f.handlers.get('move')();
  assert.deepEqual(f.draws.at(-1), [129 * 4 - 50, 35 * 4 - 30]);
  assert.equal(f.progress.length, 1);
  f.animation.stop();
  assert.equal(f.handlers.size, 0);
});

test('speed is available before starting and replay applies it while resetting pause', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(html.indexOf('id="astar-speed"') < html.indexOf('id="astar-playback" hidden'));
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { disabled: false, value: id === '#search-algorithm' ? 'astar' : '0.25',
      addEventListener(name, fn) { this[name] = fn; } });
    return elements.get(id);
  };
  const starts = [], speeds = [], requests = [];
  const source = fs.readFileSync(path.join(__dirname, '../virtual-dispatch.js'), 'utf8');
  const env = vm.createContext({ AbortController, document: { querySelector: element }, map: {},
    mode: 'virtual', modeGeneration: 1, scenarioId: 's', scenarioRevision: 2, selectedVehicleId: 'v',
    draft: { draftId: 'd', selectedVehicleId: 'v', restrictionRevision: 2 }, points: {}, dispatchSubmitting: false,
    routeOperations: new Set(), setInterval: () => 1, clearInterval() {}, setStatus() {},
    api: async (_url, options) => { requests.push(JSON.parse(options.body)); return { searchTrace: trace, routeGeojson: route }; },
    virtualMapLayers: { removeLayer() {}, addLayer() {} }, routeLayerGroup: {},
    installSearchAnimation: () => ({ start: (result, options) => starts.push({ result, options }),
      setSpeed: speed => speeds.push(speed), pause() {}, stop() {} }),
  });
  vm.runInContext(source.slice(source.indexOf('const astarShow ='), source.indexOf('\nasync function generateRequest')), env);
  await element('#astar-show').click();
  assert.equal(element('#astar-replay').disabled, false);
  element('#astar-pause').click();
  element('#astar-speed').value = '0.1';
  element('#astar-replay').click();
  assert.equal(starts.length, 2);
  assert.equal(starts[1].result, starts[0].result);
  assert.equal(starts[1].options.animate, true);
  assert.equal(speeds.at(-1), 0.1);
  assert.equal(element('#astar-pause').textContent, '일시 정지');
  assert.equal(element('#astar-pause').disabled, false);
  element('#search-algorithm').value = 'dijkstra';
  element('#search-algorithm').change();
  assert.equal(element('#astar-playback').hidden, true);
  await element('#astar-show').click();
  assert.equal(requests.at(-1).algorithm, 'dijkstra');
  element('#search-algorithm').value = 'greedy';
  element('#search-algorithm').change();
  await element('#astar-show').click();
  assert.equal(requests.at(-1).algorithm, 'greedy');
});

function searchControllerFixture(response) {
  const elements = new Map(), requests = [], starts = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { disabled: false, value: id === '#search-algorithm' ? 'astar' : '1',
      addEventListener(name, fn) { this[name] = fn; } });
    return elements.get(id);
  };
  const env = vm.createContext({ AbortController, document: { querySelector: element }, map: {},
    mode: 'virtual', modeGeneration: 1, scenarioId: 's', scenarioRevision: 2, selectedVehicleId: 'v',
    draft: { draftId: 'd', selectedVehicleId: 'v', restrictionRevision: 2, graphVersion: 'g',
      requestedProfile: { vehicleProfile: 'semi' } },
    points: { origin: { lat: 35, lon: 129 }, waypoints: [{ lat: 35.01, lon: 129.01 }],
      destination: { lat: 35.02, lon: 129.02 } }, dispatchSubmitting: false,
    routeOperations: new Set(), setInterval: () => 1, clearInterval() {}, setStatus() {},
    api: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return response ? response(options) : { searchTrace: trace, routeGeojson: route };
    },
    virtualMapLayers: { removeLayer() {}, addLayer() {} }, routeLayerGroup: {},
    installSearchAnimation: () => ({ start: result => starts.push(result), setSpeed() {}, pause() {}, stop() {} }),
  });
  const source = fs.readFileSync(path.join(__dirname, '../virtual-dispatch.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('const astarShow ='), source.indexOf('\nasync function generateRequest')), env);
  return { env, element, requests, starts,
    stop: () => element('#astar-stop').click(),
    start: () => element('#astar-show').click(),
    algorithm(value) { element('#search-algorithm').value = value; element('#search-algorithm').change(); },
  };
}

test('algorithm switches, stopping, speed changes, and identical new drafts reuse search results', async () => {
  const f = searchControllerFixture();
  for (const algorithm of ['astar', 'dijkstra', 'greedy', 'astar', 'dijkstra', 'greedy']) {
    f.algorithm(algorithm); await f.start();
  }
  assert.equal(f.requests.length, 3);
  f.stop();
  f.env.draft = { ...f.env.draft, draftId: 'new-draft' };
  f.element('#astar-speed').value = '0.25';
  f.element('#astar-speed').change({ target: f.element('#astar-speed') });
  await f.start();
  assert.equal(f.requests.length, 3);
  assert.equal(f.starts.at(-1).draftId, 'new-draft');
});

for (const point of ['origin', 'waypoints', 'destination']) {
  test(`changing ${point} invalidates every algorithm's cached search`, async () => {
    const f = searchControllerFixture();
    for (const algorithm of ['astar', 'dijkstra', 'greedy']) { f.algorithm(algorithm); await f.start(); }
    f.stop();
    if (point === 'waypoints') f.env.points.waypoints.push({ lat: 35.015, lon: 129.015 });
    else f.env.points[point].lat += 0.001;
    for (const algorithm of ['astar', 'dijkstra', 'greedy']) { f.algorithm(algorithm); await f.start(); }
    assert.equal(f.requests.length, 6);
  });
}

test('scenario, restrictions, vehicle profile, and graph changes invalidate the cache', async () => {
  const f = searchControllerFixture();
  await f.start();
  const changes = [
    () => { f.env.scenarioId = 'another'; },
    () => { f.env.scenarioRevision++; f.env.draft.restrictionRevision++; },
    () => { f.env.selectedVehicleId = 'another'; f.env.draft.selectedVehicleId = 'another'; },
    () => { f.env.draft.requestedProfile.vehicleProfile = 'small'; },
    () => { f.env.draft.graphVersion = 'new-graph'; },
  ];
  for (const change of changes) { f.stop(); change(); await f.start(); }
  assert.equal(f.requests.length, 6);
  f.stop();
  f.env.draft.expiresAt = new Date(0).toISOString();
  await f.start();
  assert.equal(f.requests.length, 6);
  assert.equal(f.element('#astar-show').disabled, true);
});

test('transient failures retry, while no-route exploration can be replayed from cache', async () => {
  let calls = 0;
  const f = searchControllerFixture(() => {
    if (++calls === 1) throw { code: 'ROUTING_UNAVAILABLE', message: 'Unavailable' };
    throw { code: 'ROUTE_NOT_FOUND', details: { searchTrace: trace } };
  });
  await f.start();
  await f.start();
  assert.equal(f.requests.length, 2);
  f.stop(); await f.start();
  assert.equal(f.requests.length, 2);
  assert.equal(f.starts.at(-1).searchTrace.events.length, 3);
});
