const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../virtual-dispatch.js'), 'utf8');
function loadFunction(context, name) {
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf('\n}', start) + 2;
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
}

for (const change of ['monitoring', 'mode round trip', 'scenario change']) {
  test(`late scenario refresh cannot redraw blockages after ${change}`, async () => {
    let resolve;
    let renders = 0;
    const response = new Promise(done => { resolve = done; });
    const context = vm.createContext({
      mode: 'virtual', modeGeneration: 1, scenarioId: 's1', scenarioRevision: 0, eventScenarioId: 's1', lastEventId: '',
      api: () => response, brushHistory: { sync() {} },
      renderRestrictions: () => renders++, renderVehicles() {}, renderRequests() {}, renderEvents() {},
      syncTripCompletions() {}, syncNoRouteAlarms() {},
    });
    loadFunction(context, 'loadScenarioData');
    const refresh = context.loadScenarioData();
    if (change === 'monitoring') context.mode = 'normal';
    else if (change === 'mode round trip') context.modeGeneration += 2;
    else context.scenarioId = 's2';
    resolve({ restrictionRevision: 1, restrictions: [{ kind: 'BLOCKED' }] });
    await refresh;
    assert.equal(renders, 0);
  });
}

test('leaving during virtual startup detaches layers and cannot restart virtual polling', async () => {
  let resolveStartup;
  let polls = 0;
  let attached = false;
  const noop = () => {};
  const group = { clearLayers: noop };
  const context = vm.createContext({
    mode: 'normal', modeGeneration: 0, window: {},
    document: { body: { classList: { toggle: noop } } },
    cancelInFlightRouteCalculation: noop, roadBrush: { reset: noop },
    cancelPointPlacement: noop, hideRouteContextMenu: noop, endpointDrag: null,
    map: { getContainer: () => ({ style: {} }), invalidateSize: noop },
    virtualMapLayers: { addTo: () => { attached = true; }, remove: () => { attached = false; } },
    virtualPanel: {}, normalTab: { setAttribute: noop }, virtualTab: { setAttribute: noop },
    liveViewBeforeVirtual: false, normalSectionVisibility: { hide: noop, restore: noop },
    loadScenarios: () => new Promise(done => { resolveStartup = done; }), brushHistory: { sync() {} },
    loadScenarioData: async () => {}, setStatus: noop,
    pollTimer: null, vehiclePollTimer: null,
    setInterval: () => { polls++; return polls; }, clearInterval: noop, setTimeout: noop,
    noRouteAlarm: {}, tripCompletionMessage: {}, completionDismissTimer: null,
    seenNoRouteKeys: new Set(), clearRouteGroup: noop, clearVirtualVehicleMarkers: noop,
    routeLayerGroup: group, activeRouteLayerGroup: group, pointLayerGroup: group, restrictionLayerGroup: group,
  });
  loadFunction(context, 'switchMode');
  const entering = context.switchMode('virtual');
  assert.equal(attached, true);
  await context.switchMode('normal');
  assert.equal(attached, false);
  resolveStartup();
  await entering;
  assert.equal(context.mode, 'normal');
  assert.equal(attached, false);
  assert.equal(polls, 0);
});
