const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../virtual-dispatch.js'), 'utf8').replace(/\r\n/g, '\n');
function fixture(touch = true) {
  const handlers = {};
  const mapHandlers = {};
  const commits = [];
  const context = vm.createContext({
    pointPlacement: { touch }, movingPin: { setLatLng() {} }, endpointDrag: null,
    pointPlacementPointerStart: null, pointPlacementPointers: new Set(),
    mode: 'virtual', pickMode: 'origin', Date, Math,
    hideRouteContextMenu() {},
    commitRoutePointPlacement(point) { commits.push(point); },
    map: {
      getContainer: () => ({ addEventListener: (name, handler) => { handlers[name] = handler; } }),
      mouseEventToLatLng: event => ({ lat: event.clientY, lng: event.clientX }),
      on: (name, handler) => { mapHandlers[name] = handler; },
    },
  });
  const start = source.indexOf("map.getContainer().addEventListener('pointerdown', event => {\n  if (!pointPlacement");
  const end = source.indexOf("\nnormalTab.addEventListener", start);
  vm.runInContext(source.slice(start, end), context);
  const moveStart = source.indexOf("map.getContainer().addEventListener('pointermove', event => {");
  const moveEnd = source.indexOf("\nrestrictionBulkCancel", moveStart);
  vm.runInContext(source.slice(moveStart, moveEnd), context);
  const clickStart = source.indexOf("map.on('click', (event) => {");
  const clickEnd = source.indexOf('\nfunction commitRoutePointPlacement', clickStart);
  vm.runInContext(source.slice(clickStart, clickEnd), context);
  function fire(type, x = 100, y = 200, id = 1, control = false) {
    handlers[type]({ pointerId: id, button: 0, pointerType: touch ? 'touch' : 'mouse',
      clientX: x, clientY: y, target: { closest: () => control } });
  }
  return { context, commits, fire, mapHandlers };
}

test('touch tap places at the tapped location without depending on a Leaflet click', () => {
  const f = fixture();
  f.fire('pointerdown');
  f.fire('pointerup', 103, 202);
  assert.equal(f.commits.length, 1);
  assert.equal(f.commits[0].lng, 103);
  assert.equal(f.commits[0].lat, 202);
});

test('touch pan returning to its start does not place an endpoint', () => {
  const f = fixture();
  f.fire('pointerdown');
  f.fire('pointermove', 130, 240);
  f.fire('pointerup');
  f.mapHandlers.click({ latlng: { lat: 200, lng: 100 } });
  assert.equal(f.commits.length, 0);
});

test('pinch gesture does not place, and a subsequent tap still works', () => {
  const f = fixture();
  f.fire('pointerdown');
  f.fire('pointerdown', 120, 220, 2);
  f.fire('pointerup', 120, 220, 2);
  f.fire('pointerup');
  assert.equal(f.commits.length, 0);
  f.fire('pointerdown');
  f.fire('pointerup');
  assert.equal(f.commits.length, 1);
});

test('cancelled pointers, long presses, and controls never place', () => {
  const f = fixture();
  f.fire('pointerdown');
  f.fire('pointercancel');
  f.fire('pointerup');
  f.fire('pointerdown');
  f.context.pointPlacementPointerStart.time -= 600;
  f.fire('pointerup');
  f.fire('pointerdown', 100, 200, 1, true);
  f.fire('pointerup');
  assert.equal(f.commits.length, 0);
});

test('mouse retains click placement and drag-release placement', () => {
  const f = fixture(false);
  f.fire('pointerdown');
  f.fire('pointerup');
  assert.equal(f.commits.length, 0);
  f.mapHandlers.click({ latlng: { lat: 2, lng: 1 } });
  assert.equal(f.commits.length, 1);
  f.fire('pointerdown');
  f.fire('pointerup', 150, 250);
  assert.equal(f.commits.length, 2);
});

for (const touch of [true, false]) for (const kind of ['origin', 'destination', 'waypoint']) {
  test(`${touch ? 'touch' : 'mouse'} ${kind} activation starts preview with the appropriate map interaction`, () => {
    let disabled = false;
    let instruction;
    let options;
    let touchDragInstalled = false;
    let previewStarted = false;
    const pin = { getElement: () => null, addTo() { return this; } };
    const hint = { hidden: true, querySelector: () => ({ set textContent(value) { instruction = value; } }) };
    const context = vm.createContext({
      roadBrush: { reset() {} }, scenarioId: '1', routePointPointerType: touch ? 'touch' : 'mouse',
      cancelPointPlacement() {}, map: { getCenter: () => ({}),
        dragging: { enabled: () => true, disable: () => { disabled = true; } },
        getContainer: () => ({ style: {} }) },
      L: { marker: (_point, value) => { options = value; return pin; } }, pointIcon() {},
      startEndpointDrag: (value, marker) => { assert.equal(value, kind); assert.equal(marker, pin); previewStarted = true; },
      installTouchPlacementDrag: () => { touchDragInstalled = true; }, setStatus() {},
      points: { waypoints: [] }, pointPlacementHint: hint,
      routePointToolbar: { isOpen: () => false, open() {} },
    });
    const start = source.indexOf('function beginRoutePointPick(');
    const end = source.indexOf('\n}', start) + 2;
    vm.runInContext(source.slice(start, end), context);
    context.beginRoutePointPick(kind);
    assert.equal(disabled, !touch);
    assert.equal(context.pointPlacement.touch, touch);
    assert.equal(hint.hidden, true);
    assert.equal(options.draggable, touch);
    assert.equal(options.interactive, touch);
    assert.equal(touchDragInstalled, touch);
    assert.equal(previewStarted, true);
    assert.ok(instruction.includes(touch ? '탭' : '클릭'));
  });
}

test('touch pin dragging continuously previews snapping and places on release', () => {
  const handlers = {};
  let queued = 0;
  const commits = [];
  const pin = { on: (name, fn) => { handlers[name] = fn; }, getElement: () => null,
    getLatLng: () => ({ lat: 35, lng: 129 }) };
  const context = vm.createContext({
    pointPlacement: { touch: true }, movingPin: pin, endpointDrag: { marker: pin },
    pointPlacementPointerStart: {}, queueEndpointSnapPreview: () => queued++,
    commitRoutePointPlacement: point => commits.push(point),
  });
  const start = source.indexOf('function installTouchPlacementDrag(');
  const end = source.indexOf('\n}', start) + 2;
  vm.runInContext(source.slice(start, end), context);
  context.installTouchPlacementDrag(pin);
  handlers.dragstart();
  assert.equal(context.pointPlacementPointerStart, null);
  handlers.drag();
  handlers.drag();
  assert.equal(queued, 2);
  handlers.dragend();
  assert.deepEqual(commits, [{ lat: 35, lng: 129 }]);
  context.pointPlacement = null;
  handlers.drag();
  handlers.dragend();
  assert.equal(queued, 2);
  assert.equal(commits.length, 1);
});

for (const kind of ['origin', 'destination', 'waypoint']) {
  test(`touch ${kind} shows initial loading and snapped coordinates with distance`, () => {
    const info = {};
    const marker = {};
    const circle = { setLatLng() {} };
    const context = vm.createContext({
      pointPlacement: { touch: true }, movingPin: marker,
      pointPlacementHint: { querySelector: () => info },
      routePointToolbar: { setPreview() {} },
      endpointSnapPreviewLayerGroup: { eachLayer() {} },
      formatPoint: point => `${point.lat}, ${point.lon}`,
      points: { waypoints: [] }, document: { querySelector: () => ({}) },
    });
    const start = source.indexOf('function renderEndpointSnapPreview(');
    const end = source.indexOf('\n}', start) + 2;
    vm.runInContext(source.slice(start, end), context);
    const drag = { kind, marker, snapCircle: circle, snapRipple: circle };
    context.renderEndpointSnapPreview(drag, { lat: 35, lon: 129 });
    assert.match(info.textContent, /확인하는 중/);
    context.renderEndpointSnapPreview(drag, { lat: 35.1, lon: 129.1, distanceM: 12.34 });
    assert.match(info.textContent, /35.1, 129.1/);
    assert.match(info.textContent, /12.3 m/);
  });
}
