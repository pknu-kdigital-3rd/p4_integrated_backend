const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup() {
  const handlers = {}, documentHandlers = {}, documentCapture = {}, classes = new Set(), moves = [], menus = [], brushPresses = [];
  const container = {
    addEventListener: (type, fn) => { handlers[type] = fn; },
    classList: { add: value => classes.add(value), remove: (...values) => values.forEach(value => classes.delete(value)) },
    dispatchEvent: event => menus.push(event),
  };
  const context = vm.createContext({
    mapContainer: container, rightButtonPan: null, leftButtonPan: null,
    map: { panBy: delta => moves.push(delta), once() {}, dragging: { enabled: () => false } },
    window: { __operatorRoadBrushPointerDown: event => { brushPresses.push(event.button); return event.button === 0; },
      __operatorPointPlacementActive: () => false, addEventListener() {} },
    document: { addEventListener: (type, fn, capture = false) => { documentHandlers[type] = fn; documentCapture[type] = capture; } },
    pauseLiveMapForManualPan() {}, L: { DomEvent: { stop() {} } },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
  });
  const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  const start = source.indexOf("mapContainer.addEventListener('mousedown',event=>{");
  const end = source.indexOf('\nwindow.__operatorMap=map;', start);
  vm.runInContext(source.slice(start, end), context);
  const event = (button, x, y, pin = false) => ({ button, clientX: x, clientY: y,
    target: { closest: selector => pin && selector === '.virtual-point-icon' },
    preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
  const dispatchThroughLayer = (type, value) => {
    // An interactive layer stops propagation at the target. Document capture
    // listeners have already run; document bubble listeners never receive it.
    if (documentCapture[type]) documentHandlers[type](value);
  };
  return { handlers, documentHandlers, classes, moves, menus, brushPresses, event, dispatchThroughLayer };
}

for (const pin of [false, true]) {
  test(`right-drag pans with native dragging disabled${pin ? ', starting over a route pin' : ''}`, () => {
    const f = setup();
    f.handlers.mousedown(f.event(2, 100, 200, pin));
    assert.equal(f.classes.has('right-button-panning'), true);
    f.documentHandlers.mousemove(f.event(2, 130, 250));
    f.documentHandlers.mouseup(f.event(2, 130, 250));
    assert.equal(f.moves.length, 1);
    assert.equal(f.moves[0][0], -30);
    assert.equal(f.moves[0][1], -50);
    assert.equal(f.classes.has('right-button-panning'), false);
    assert.equal(f.menus.length, 0);
    assert.equal(f.brushPresses.length, 0);
  });
}

test('left press still belongs to the brush and stationary right-click opens the menu', () => {
  const f = setup();
  f.handlers.mousedown(f.event(0, 100, 200));
  assert.deepEqual(f.brushPresses, [0]);
  assert.equal(f.classes.has('left-button-panning'), false);
  f.handlers.mousedown(f.event(2, 100, 200));
  f.documentHandlers.mouseup(f.event(2, 100, 200));
  assert.equal(f.menus.length, 1);
});

test('right-drag receives movement and release even when a map layer stops bubbling', () => {
  const f = setup();
  f.handlers.mousedown(f.event(2, 100, 200));
  f.dispatchThroughLayer('mousemove', f.event(2, 140, 260));
  f.dispatchThroughLayer('mouseup', f.event(2, 140, 260));
  assert.equal(f.moves.length, 1);
  assert.equal(f.moves[0][0], -40);
  assert.equal(f.moves[0][1], -60);
  assert.equal(f.classes.has('right-button-panning'), false);
  assert.equal(f.menus.length, 0);
  f.documentHandlers.mousemove(f.event(0, 160, 280));
  assert.equal(f.moves.length, 1, 'release must end the drag');
});

test('right-button movement cannot extend a brush stroke, even with both buttons held', () => {
  const source = fs.readFileSync(path.join(__dirname, '../road-brush.js'), 'utf8');
  const start = source.indexOf('  function appendStrokePoint(');
  const end = source.indexOf('\n  function startStroke', start);
  let drawn = 0;
  const context = vm.createContext({
    isActive: () => true, tool: 'paint', busy: false,
    stroke: { radiusM: 5, points: [{ lat: 1, lon: 1 }] },
    container: { getBoundingClientRect: () => ({ left: 0, top: 0, right: 1000, bottom: 600 }) },
    position: () => ({ lat: 2, lng: 2 }), radiusAt: () => 5, showCursor() {},
    map: { distance: () => 100 }, line: { addLatLng: () => drawn++ },
  });
  vm.runInContext(source.slice(start, end), context);
  context.appendStrokePoint({ buttons: 3, clientX: 200, clientY: 200, target: { closest: () => null } });
  assert.equal(drawn, 0);
  assert.equal(context.stroke.points.length, 1);
});
