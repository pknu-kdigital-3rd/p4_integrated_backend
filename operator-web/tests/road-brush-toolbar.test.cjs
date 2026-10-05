const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(tool) {
    this.dataset = { roadTool: tool };
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.attributes = {};
    this.listeners = {};
    this.classList = { add() {}, remove() {} };
  }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, callback) { (this.listeners[type] ??= []).push(callback); }
  fire(type, values = {}) {
    const event = { button: 0, pointerId: 1, target: this, stopPropagation() {}, preventDefault() {}, ...values };
    for (const callback of this.listeners[type] ?? []) callback(event);
  }
  closest(selector) { return (this.dataset.roadTool && (selector === 'button' || selector === '[data-road-tool]')) || (this.dataset.roadHistory && (selector === 'button' || selector === '[data-road-history]')) ? this : null; }
  setPointerCapture() {}
  getBoundingClientRect() { return { left: parseFloat(this.style.left ?? '350'), top: parseFloat(this.style.top ?? '12'), width: 300, height: 80 }; }
}

function setup() {
  const panel = new Element();
  const handle = new Element();
  const buttons = ['paint', 'erase', 'exit'].map(tool => new Element(tool));
  const historyButtons = ['undo', 'redo'].map(action => { const button = new Element(); button.dataset.roadHistory = action; button.disabled = true; return button; });
  panel.querySelector = () => handle;
  panel.querySelectorAll = selector => selector === '[data-road-history]' ? historyButtons : buttons;
  const container = { append() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 600 }) };
  const selected = [];
  const historyActions = [];
  const context = vm.createContext({ document: { createElement: () => panel }, ResizeObserver: class { observe() {} } });
  for (const file of ['panel-drag.js', 'road-brush-toolbar.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/^import .*;\r?\n/gm, '').replaceAll('export function', 'function');
    vm.runInContext(source, context);
  }
  const toolbar = context.installRoadBrushToolbar(container, { onSelect: tool => { selected.push(tool); toolbar.setTool(tool); }, onUndo: () => historyActions.push('undo'), onRedo: () => historyActions.push('redo') });
  return { panel, handle, buttons, toolbar, selected, historyButtons, historyActions };
}

test('draw and erase share a toolbar; exit closes it and busy state still allows exit', () => {
  const { panel, buttons, toolbar, selected } = setup();
  assert.equal(panel.hidden, true);
  toolbar.setTool('paint');
  assert.equal(panel.hidden, false);
  assert.equal(buttons[0].attributes['aria-pressed'], 'true');
  panel.fire('click', { target: buttons[1] });
  assert.equal(buttons[0].attributes['aria-pressed'], 'false');
  assert.equal(buttons[1].attributes['aria-pressed'], 'true');
  toolbar.setBusy(true);
  panel.fire('click', { target: buttons[0] });
  assert.deepEqual(selected, ['erase']);
  assert.equal(buttons[2].disabled, false);
  panel.fire('click', { target: buttons[2] });
  assert.equal(panel.hidden, true);
  assert.deepEqual(selected, ['erase', null]);
});

test('mouse or touch dragging stays inside the map and preserves its position across mode changes', () => {
  const { panel, handle, toolbar } = setup();
  toolbar.setTool('paint');
  handle.fire('pointerdown', { clientX: 360, clientY: 20, pointerType: 'touch' });
  handle.fire('pointermove', { clientX: 2000, clientY: 2000 });
  handle.fire('pointerup');
  assert.equal(panel.style.left, '700px');
  assert.equal(panel.style.top, '520px');
  toolbar.setTool(null);
  toolbar.setTool('erase');
  assert.equal(panel.style.left, '700px');
  handle.fire('pointerdown', { clientX: 710, clientY: 528 });
  handle.fire('pointermove', { clientX: -100, clientY: -100 });
  handle.fire('pointerup');
  assert.equal(panel.style.left, '0px');
  assert.equal(panel.style.top, '0px');
});

test('toolbar pointer events cannot bubble into map drawing or panning', () => {
  const { panel } = setup();
  for (const type of ['pointerdown', 'mousedown', 'touchstart', 'dblclick', 'contextmenu']) {
    let stopped = false;
    panel.fire(type, { stopPropagation() { stopped = true; } });
    assert.equal(stopped, true, type);
  }
});

test('undo and redo reflect available history and are disabled while processing', () => {
  const { panel, toolbar, historyButtons, historyActions } = setup();
  toolbar.setHistory({ canUndo: true, canRedo: false });
  panel.fire('click', { target: historyButtons[0] });
  panel.fire('click', { target: historyButtons[1] });
  assert.deepEqual(historyActions, ['undo']);
  toolbar.setBusy(true);
  panel.fire('click', { target: historyButtons[0] });
  assert.deepEqual(historyActions, ['undo']);
  toolbar.setHistory({ canUndo: false, canRedo: true });
  toolbar.setBusy(false);
  panel.fire('click', { target: historyButtons[1] });
  assert.deepEqual(historyActions, ['undo', 'redo']);
});

test('Escape and scenario resets hide the toolbar and restore map gestures', () => {
  const { toolbar, panel } = setup();
  const listeners = {};
  const gesture = () => ({ active: true, enabled() { return this.active; }, disable() { this.active = false; }, enable() { this.active = true; } });
  const map = { getContainer: () => ({ style: {} }), dragging: gesture(), touchZoom: gesture(), on() {} };
  const context = vm.createContext({
    L: { layerGroup: () => ({ addTo() { return this; }, clearLayers() {} }) },
    document: { addEventListener(type, fn) { listeners[type] = fn; } },
    window: { addEventListener() {}, clearTimeout() {} },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../road-brush.js'), 'utf8').replace('export function', 'function'), context);
  const brush = context.installRoadBrush(map, { isActive: () => true, onStroke() {}, onStatus() {}, onToolChange: toolbar.setTool });
  brush.setTool('paint');
  assert.equal(panel.hidden, false);
  assert.equal(map.dragging.active, false);
  listeners.keydown({ key: 'Escape' });
  assert.equal(panel.hidden, true);
  assert.equal(map.dragging.active, true);
  brush.setTool('erase');
  brush.reset();
  assert.equal(panel.hidden, true);
  assert.equal(map.touchZoom.active, true);
});
