const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../virtual-route-motion.js'), 'utf8').replace('export function', 'function'), context);
const create = coordinates => context.createVirtualRouteMotion({ type: 'LineString', coordinates });

test('intermediate animation positions follow a short bent route instead of cutting across it', () => {
  const route = create([[129, 35], [129.001, 35], [129.001, 35.001]]);
  for (let index = 0; index <= 100; index++) {
    const point = route.sample(route.total * index / 100);
    assert.ok(Math.abs(point.lat - 35) < 1e-9 || Math.abs(point.lon - 129.001) < 1e-9);
  }
  assert.equal(route.sample(0).lon, 129);
  assert.equal(route.sample(route.total).lat, 35.001);
});

test('distance offsets distinguish return paths and tolerate duplicate coordinates', () => {
  const route = create([[129, 35], [129, 35], [129.001, 35], [129.001, 35.001], [129, 35.001], [129, 35]]);
  const middle = route.sample(route.total / 2);
  assert.ok(middle.lat > 35.0009);
  assert.equal(route.sample(-100).lat, 35);
  assert.equal(route.sample(route.total + 100).lat, 35);
  assert.equal(create([[129, 35], [129, 35]]), null);
});

test('route changes snap to the new route, and polling animation keeps every frame on its geometry', () => {
  const source = fs.readFileSync(path.join(__dirname, '../virtual-dispatch.js'), 'utf8');
  let tick, point, time = 0;
  const marker = { getLatLng: () => ({ lat: point?.[0] ?? 35, lng: point?.[1] ?? 129 }), setLatLng: value => { point = value; } };
  const animation = vm.createContext({
    virtualVehicleRouteMotion: new Map(), virtualVehicleAnimationFrames: new Map(),
    createVirtualRouteMotion: context.createVirtualRouteMotion, stopVehicleMarkerAnimation() {},
    performance: { now: () => time }, requestAnimationFrame: fn => { tick = fn; return 1; },
  });
  const start = source.indexOf('function animateVehicleMarker('), end = source.indexOf('\n}', start) + 2;
  vm.runInContext(source.slice(start, end), animation);
  const geometry = { type: 'LineString', coordinates: [[129, 35], [129.001, 35], [129.001, 35.001]] };
  const route = context.createVirtualRouteMotion(geometry);
  const state = { activeRouteId: '1', offsetM: 0, trip: { routes: [{ routeId: '1', routeGeojson: geometry }] } };
  animation.animateVehicleMarker('v1', marker, { lat: 35, lon: 129 }, state);
  state.offsetM = route.total;
  animation.animateVehicleMarker('v1', marker, { lat: 35.001, lon: 129.001 }, state);
  for (time = 30; time <= 300; time += 30) {
    tick(time);
    assert.ok(Math.abs(point[0] - 35) < 1e-9 || Math.abs(point[1] - 129.001) < 1e-9);
  }
  state.activeRouteId = '2'; state.offsetM = 0;
  state.trip.routes.push({ routeId: '2', routeGeojson: { type: 'LineString', coordinates: [[130, 36], [130.001, 36]] } });
  animation.animateVehicleMarker('v1', marker, { lat: 36, lon: 130 }, state);
  assert.equal(point[0], 36);
  assert.equal(point[1], 130);
});
