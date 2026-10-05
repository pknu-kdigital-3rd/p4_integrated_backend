const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(kind) {
    this.dataset = kind ? { pointKind: kind } : {};
    this.style = {}; this.attributes = {}; this.listeners = {}; this.hidden = false;
    this.classList = { add() {}, remove() {} };
    this.captured = new Set();
  }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, callback) { (this.listeners[type] ??= []).push(callback); }
  fire(type, values = {}) {
    const event = { button: 0, pointerId: 1, clientX: 400, clientY: 60, pointerType: 'touch',
      target: this, detail: 1, stopPropagation() {}, preventDefault() {}, ...values };
    for (const callback of this.listeners[type] ?? []) callback(event);
  }
  closest(selector) {
    return (this.dataset.pointKind && (selector === 'button' || selector === '[data-point-kind]'))
      || (this.dataset.pointExit && (selector === 'button' || selector === '[data-point-exit]')) ? this : null;
  }
  setPointerCapture(id) { this.captured.add(id); }
  hasPointerCapture(id) { return this.captured.has(id); }
  releasePointerCapture(id) { this.captured.delete(id); }
  getBoundingClientRect() { return { left: 350, top: 12, width: 300, height: 200 }; }
}
function setup() {
  const panel = new Element(), handle = new Element(), preview = new Element();
  const buttons = ['origin', 'destination', 'waypoint'].map(kind => new Element(kind));
  const exit = new Element(); exit.dataset.pointExit = true;
  panel.querySelector = selector => selector === '[data-point-preview]' ? preview : handle;
  panel.querySelectorAll = () => buttons;
  const container = { append() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 600 }) };
  const context = vm.createContext({ document: { createElement: () => panel }, ResizeObserver: class { observe() {} } });
  for (const file of ['panel-drag.js', 'route-point-toolbar.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/^import .*;\r?\n/gm, '').replaceAll('export function', 'function');
    vm.runInContext(source, context);
  }
  const actions = [];
  const toolbar = context.installRoutePointToolbar(container, {
    onStart: (kind, event) => actions.push(['start', kind, event.pointerType]),
    onMove: event => actions.push(['move', event.clientX, event.clientY]),
    onDrop: event => actions.push(['drop', event.clientX, event.clientY]),
    onCancel: () => actions.push(['cancel']), onExit: () => { actions.push(['exit']); toolbar.close(); },
  });
  toolbar.open();
  return { panel, buttons, toolbar, actions, preview, exit };
}

for (const pointerType of ['touch', 'mouse']) for (const kind of ['origin', 'destination', 'waypoint']) {
  test(`${pointerType} ${kind} starts directly on press and drops in one captured gesture`, () => {
    const f = setup();
    const button = f.buttons.find(value => value.dataset.pointKind === kind);
    button.fire('pointerdown', { pointerType });
    assert.deepEqual(f.actions, [['start', kind, pointerType]]);
    assert.equal(button.hasPointerCapture(1), true);
    button.fire('pointermove', { clientX: 750, clientY: 400 });
    button.fire('pointerup', { clientX: 750, clientY: 400 });
    assert.deepEqual(f.actions.slice(1), [['move', 750, 400], ['drop', 750, 400]]);
    assert.equal(button.hasPointerCapture(1), false);
    f.panel.fire('click', { target: button });
    assert.equal(f.actions.length, 3, 'compatibility click must not restart placement');
  });
}

test('tap selects locate mode and leaves it active without dropping', () => {
  const f = setup(), button = f.buttons[0];
  button.fire('pointerdown'); button.fire('pointerup');
  f.panel.fire('click', { target: button });
  assert.deepEqual(f.actions, [['start', 'origin', 'touch']]);
  assert.equal(button.attributes['aria-pressed'], 'true');
  f.toolbar.setSelection(null);
  assert.equal(f.toolbar.isOpen(), true, 'menu stays available after map placement');
  assert.equal(button.attributes['aria-pressed'], 'false');
});

for (const reason of ['outside map', 'inside menu', 'pointercancel', 'lostpointercapture']) {
  test(`${reason} cancels a pin without placing it`, () => {
    const f = setup(), button = f.buttons[2];
    button.fire('pointerdown');
    button.fire('pointermove', { clientX: 750, clientY: 400 });
    if (reason === 'outside map') button.fire('pointerup', { clientX: 1100, clientY: 400 });
    else if (reason === 'inside menu') button.fire('pointerup');
    else button.fire(reason);
    assert.deepEqual(f.actions.at(-1), ['cancel']);
    assert.equal(f.actions.some(value => value[0] === 'drop'), false);
  });
}

test('busy disables pin gestures, exit closes the menu, and preview is visible', () => {
  const f = setup();
  f.toolbar.setPreview('스냅 위치 35, 129 · 도로까지 2 m');
  assert.match(f.preview.textContent, /도로까지 2 m/);
  f.toolbar.setBusy(true);
  f.buttons[0].fire('pointerdown');
  assert.equal(f.actions.length, 0);
  assert.equal(f.buttons[0].disabled, true);
  f.panel.fire('click', { target: f.exit });
  assert.equal(f.toolbar.isOpen(), false);
});

test('closing during a captured drag prevents a late drop', () => {
  const f = setup(), button = f.buttons[0];
  button.fire('pointerdown');
  button.fire('pointermove', { clientX: 750, clientY: 400 });
  f.toolbar.close();
  button.fire('pointerup', { clientX: 750, clientY: 400 });
  assert.equal(button.hasPointerCapture(1), false);
  assert.equal(f.actions.some(value => value[0] === 'drop'), false);
});

test('dispatch wiring moves the map pin and requests snapping during the toolbar gesture', () => {
  const source = fs.readFileSync(path.join(__dirname, '../virtual-dispatch.js'), 'utf8');
  let callbacks, selected, moved, snapped = 0, dropped, cancelled;
  const pin = { setLatLng: point => { moved = point; } };
  const context = vm.createContext({
    installRoutePointToolbar: (_container, handlers) => { callbacks = handlers; return { open() {} }; },
    map: { getContainer: () => ({}), getCenter: () => ({ lat: 35, lng: 129 }),
      mouseEventToLatLng: event => ({ lat: event.clientY, lng: event.clientX }) },
    mode: 'virtual', scenarioId: 's1', routeOperations: new Map(), routePointPointerType: 'mouse',
    points: { origin: { lat: 35.2, lon: 129.2 } },
    beginRoutePointPick: (kind, index, point) => { selected = { kind, index, point }; },
    pointPlacementHint: {}, pointPlacement: { touch: true }, movingPin: pin, endpointDrag: { marker: pin },
    queueEndpointSnapPreview: () => snapped++, commitRoutePointPlacement: point => { dropped = point; },
    cancelPointPlacement: options => { cancelled = options; }, setStatus() {},
  });
  const start = source.indexOf('const routePointToolbar = installRoutePointToolbar(');
  const end = source.indexOf('\nconst pointPlacementHint', start);
  vm.runInContext(source.slice(start, end), context);
  callbacks.onStart('origin', { pointerType: 'touch' });
  assert.equal(selected.kind, 'origin');
  assert.equal(selected.point.lng, 129.2);
  callbacks.onMove({ clientX: 129.3, clientY: 35.3 });
  assert.equal(moved.lng, 129.3);
  assert.equal(snapped, 1);
  callbacks.onDrop({ clientX: 129.3, clientY: 35.3 });
  assert.equal(dropped.lat, 35.3);
  callbacks.onCancel();
  assert.equal(cancelled.keepToolbar, true);
});

test('committing placement restores gestures and retains the floating menu', () => {
  const source = fs.readFileSync(path.join(__dirname, '../virtual-dispatch.js'), 'utf8');
  let removed = false, restored = false, selection = 'origin', result;
  const pin = { remove: () => { removed = true; } };
  const context = vm.createContext({
    mode: 'virtual', pickMode: 'origin', pointPlacement: { waypointIndex: null }, movingPin: pin,
    endpointDrag: null, pointPlacementPointerStart: {}, pointPlacementPointers: new Set([1]),
    pointPlacementHint: {}, routePointToolbar: { setSelection: value => { selection = value; } },
    map: { getContainer: () => ({ style: {} }) },
    restoreRoutePlacementMapDragging: () => { restored = true; },
    snapAndSetRoutePoint: (kind, point) => { result = { kind, point }; },
  });
  const start = source.indexOf('function commitRoutePointPlacement(');
  const end = source.indexOf('\n}', start) + 2;
  vm.runInContext(source.slice(start, end), context);
  context.commitRoutePointPlacement({ lat: 35, lng: 129 });
  assert.equal(removed, true);
  assert.equal(restored, true);
  assert.equal(selection, null);
  assert.equal(context.pointPlacement, null);
  assert.equal(result.kind, 'origin');
  assert.equal(result.point.lon, 129);
});
