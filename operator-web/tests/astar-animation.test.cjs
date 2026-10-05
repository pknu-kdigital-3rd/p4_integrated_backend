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
  assert.equal(replay.advance(4000).edges.get('a'), 'discovered');
  let state = replay.advance(4000);
  assert.equal(state.edges.get('a'), 'expanded');
  assert.equal(state.routeProgress, 0);
  state = replay.advance(1000);
  assert.equal(state.routeProgress, 0.5);
  assert.equal(replay.advance(1000).done, true);
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
  const fixture = vm.createContext({ AbortController,
    astarShow: { disabled: false }, astarPlayback: {}, astarPause: {}, astarStatus: {},
    document: { querySelector: () => ({}) }, scenarioId: '1', scenarioRevision: 2, draft: { draftId: '4' },
    astarController: null, astarKey: '', astarResult: null,
    astarContextKey: () => 'current', syncAstarButton() {}, setStatus() {}, setInterval: () => 1,
    api: () => new Promise(resolve => responses.push(resolve)),
    playAstarResult: () => { plays++; }, stopAstarAnimation: () => { stops++; },
  });
  vm.runInContext(source.slice(start, end), fixture);
  const old = fixture.showAstarAnimation(); fixture.astarController.abort();
  const newer = fixture.showAstarAnimation(); const controller = fixture.astarController;
  responses[0]({ marker: 'old' }); await old;
  assert.equal(fixture.astarResult, null); assert.equal(fixture.astarController, controller);
  assert.equal(stops, 0); assert.equal(plays, 0);
  responses[1]({ marker: 'new' }); await newer;
  assert.equal(fixture.astarResult.marker, 'new'); assert.equal(plays, 1);
});

test('stop, pause, hidden-page resume, and invalidation clean up animation resources', () => {
  const callbacks = new Map(), listeners = new Map(), draws = [];
  let nextFrame = 0, current = true, removed = 0;
  const ctx = { setTransform() {}, beginPath() {}, moveTo(x, y) { draws.push([x, y]); }, lineTo() {}, stroke() {} };
  const canvas = { style: {}, setAttribute() {}, getContext: () => ctx, remove() { removed++; } };
  const doc = { hidden: false, createElement: () => canvas,
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const point = (x, y) => ({ x, y, distanceTo(b) { return Math.hypot(x - b.x, y - b.y); } });
  const mapListeners = new Set();
  const map = { getZoom: () => 10, project: ([lat, lon]) => point(lon * 100, lat * 100),
    getSize: () => ({ x: 640, y: 480 }), getPixelBounds: () => ({ min: { x: 0, y: 0 } }),
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
