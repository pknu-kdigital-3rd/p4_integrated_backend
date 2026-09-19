/* Dedicated virtual routing workspace. It owns its own layers and state so
 * virtual vehicles never enter the normal tracking/live/replay selection path. */
const map = window.__operatorMap;
const virtualPanel = document.querySelector('#virtual-workspace');
const normalTab = document.querySelector('#normal-workspace');
const virtualTab = document.querySelector('#virtual-workspace-tab');
const status = document.querySelector('#virtual-status');
const scenarioSelect = document.querySelector('#virtual-scenario');
const removeScenarioButton = document.querySelector('#virtual-remove-scenario');
const vehicleSelect = document.querySelector('#virtual-vehicle');
const removeVehicleButton = document.querySelector('#virtual-remove-vehicle');
const routeLayerGroup = L.layerGroup().addTo(map);
const activeRouteLayerGroup = L.layerGroup().addTo(map);
const markerLayerGroup = L.layerGroup().addTo(map);
const pointLayerGroup = L.layerGroup().addTo(map);
const restrictionLayerGroup = L.layerGroup().addTo(map);
const routeRenderer = L.canvas({ padding: 0.5 });
const routeVisuals = new Set();
const requestList = document.querySelector('#virtual-requests');
const eventList = document.querySelector('#virtual-events');
const normalSections = ['#login', '#details', '#trip-panel', '#recordings-panel', '#error'];
let mode = 'normal';
let scenarioId = '';
let scenarioRevision = 0;
let selectedVehicleId = '';
let vehicles = [];
let draft = null;
let points = { origin: null, destination: null, waypoints: [] };
let pickMode = null;
let restrictionCorners = [];
let restrictionGeometry = null;
let pollTimer = null;
let lastEventId = '';

function token() { return sessionStorage.getItem('itsToken'); }
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(token() ? { Authorization: `Bearer ${token()}` } : {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || body.detail || `HTTP ${response.status}`);
  return body.data ?? body;
}
function setStatus(message, isError = false) {
  status.textContent = message;
  status.dataset.level = isError ? 'error' : 'info';
}
function idempotency(prefix) { return `${prefix}-${crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`}`; }
function formatPoint(point) { return point ? `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}` : 'not set'; }
function drawPoint(kind, point) {
  if (!point) return;
  const color = kind === 'origin' ? '#2a9d8f' : kind === 'destination' ? '#e63946' : '#f4a261';
  const marker = L.circleMarker([point.lat, point.lon], { radius: 8, color, fillColor: color, fillOpacity: 0.9 });
  marker.bindTooltip(kind === 'waypoint' ? 'Waypoint' : kind[0].toUpperCase() + kind.slice(1));
  pointLayerGroup.addLayer(marker);
}
function renderPoints() {
  pointLayerGroup.clearLayers();
  drawPoint('origin', points.origin);
  drawPoint('destination', points.destination);
  points.waypoints.forEach((point) => drawPoint('waypoint', point));
  document.querySelector('#virtual-origin').textContent = formatPoint(points.origin);
  document.querySelector('#virtual-destination').textContent = formatPoint(points.destination);
  document.querySelector('#virtual-waypoints').textContent = points.waypoints.length ? points.waypoints.map(formatPoint).join(' · ') : 'none';
}
function routeDisplayMetrics(style = {}) {
  return {
    // Keep these in screen pixels.  The plugin recomputes their geographic
    // positions after every map transform, while the small fixed size keeps
    // each chevron inside the colored route stroke.
    arrowFrequency: style.arrowFrequency || 42,
    arrowSize: style.arrowSize || 5.5,
  };
}
function routeStrokeScale() {
  // Leaflet weights are screen pixels.  A fixed 19px casing dominates the
  // map when zoomed out, so ease both strokes down below the close-up range.
  // Existing close-up styling is restored by zoom 14 without recreating the
  // layers (which would cause the route to flicker).
  const zoom = Number(map.getZoom());
  // Keep the low-zoom casing restrained; at the default zoom (12) it is
  // about two-thirds of the close-up width instead of nearly full thickness.
  return Math.max(0.32, Math.min(1, 0.32 + (zoom - 8) * 0.085));
}
function applyRouteStrokeWidths(visual) {
  const scale = routeStrokeScale();
  visual.outline.setStyle({ weight: Math.max(3, visual.style.outlineWeight * scale) });
  visual.line.setStyle({ weight: Math.max(2, visual.style.lineWeight * scale) });
}
function clearRouteGroup(group) {
  // leaflet-arrowheads keeps its generated polygons on the child polyline.
  // Remove those explicitly before clearing the GeoJSON group so a refresh
  // cannot leave an old set of arrows behind for the next zoom/update.
  for (const visual of routeVisuals) {
    if (visual.group !== group) continue;
    visual.line.eachLayer?.((layer) => layer.deleteArrowheads?.());
    visual.outline.eachLayer?.((layer) => layer.deleteArrowheads?.());
    routeVisuals.delete(visual);
  }
  group.clearLayers();
}
function addRouteVisual(group, routeGeojson, style, tooltip) {
  if (!routeGeojson) return;
  const outline = L.geoJSON(routeGeojson, {
    style: {
      // Draw a dark casing first so the road remains legible over both the
      // pale base map and dense map labels.  The colored route is drawn above
      // it as the smaller inner stroke.
      color: style.outlineColor || style.casingColor,
      weight: style.outlineWeight || style.casingWeight,
      opacity: style.outlineOpacity ?? style.casingOpacity,
      lineCap: 'round',
      lineJoin: 'round',
      renderer: routeRenderer,
    },
  }).addTo(group);
  const lineOptions = {
    style: {
      color: style.lineColor,
      weight: style.lineWeight,
      opacity: style.lineOpacity,
      dashArray: style.dashArray,
      lineCap: 'round',
      lineJoin: 'round',
      renderer: routeRenderer,
    },
  };
  if (style.showArrows !== false && typeof L.Polyline?.prototype.arrowheads === 'function') {
    const metrics = routeDisplayMetrics(style);
    lineOptions.arrowheads = {
      color: style.arrowColor || '#ffffff',
      fillColor: style.arrowColor || '#ffffff',
      fill: true,
      weight: 0.8,
      opacity: 0.98,
      fillOpacity: 1,
      // A smaller yawn makes a narrower, sharper chevron that stays inside
      // the inner route stroke instead of spilling over its edges.
      yawn: style.arrowYawn ?? 36,
      size: `${metrics.arrowSize.toFixed(1)}px`,
      frequency: `${metrics.arrowFrequency.toFixed(1)}px`,
    };
  }
  const line = L.geoJSON(routeGeojson, lineOptions).addTo(group);
  if (tooltip) line.bindTooltip(tooltip);
  const visual = { group, outline, line, style };
  routeVisuals.add(visual);
  applyRouteStrokeWidths(visual);
}
function renderDraft() {
  clearRouteGroup(routeLayerGroup);
  if (!draft) {
    document.querySelector('#virtual-draft-summary').textContent = 'No route draft.';
    document.querySelector('#virtual-dispatch').disabled = true;
    return;
  }
  addRouteVisual(routeLayerGroup, draft.routeGeojson, {
    outlineColor: '#3b225c', outlineWeight: 19, outlineOpacity: 0.96,
    lineColor: '#7c3aed', lineWeight: 11, lineOpacity: 0.98, arrowColor: '#ffffff', arrowYawn: 36, showArrows: true,
  }, 'Route preview');
  document.querySelector('#virtual-draft-summary').textContent = `Draft ${draft.draftId} · ${(Number(draft.distanceM || draft.route?.distanceM || 0) / 1000).toFixed(2)} km · ${(Number(draft.durationSec || draft.route?.durationSec || 0) / 60).toFixed(1)} min · restriction revision ${draft.restrictionRevision}`;
  document.querySelector('#virtual-dispatch').disabled = false;
}
function renderActiveTripRoute(vehicle) {
  clearRouteGroup(activeRouteLayerGroup);
  const trip = vehicle?.state?.trip;
  const routes = Array.isArray(trip?.routes) ? trip.routes.filter((route) => route?.routeGeojson) : [];
  if (!routes.length) return;
  const currentRoute = routes.find((route) => route.isCurrent) || routes.at(-1);
  const previousRoute = routes
    .filter((route) => route !== currentRoute)
    .sort((a, b) => Number(b.routeVersion || 0) - Number(a.routeVersion || 0))[0];
  for (const route of [previousRoute, currentRoute].filter(Boolean)) {
    const current = Boolean(route.isCurrent);
    addRouteVisual(activeRouteLayerGroup, route.routeGeojson, current
      ? { outlineColor: '#063b70', outlineWeight: 19, outlineOpacity: 0.98, lineColor: '#0875f5', lineWeight: 11, lineOpacity: 1, arrowColor: '#ffffff', arrowYawn: 36, showArrows: true }
      : { outlineColor: '#6a3800', outlineWeight: 17, outlineOpacity: 0.86, lineColor: '#f59e0b', lineWeight: 9, lineOpacity: 0.72, arrowColor: '#ffffff', arrowYawn: 36, showArrows: false },
    current ? `Active route · v${route.routeVersion}` : `Previous route · v${route.routeVersion}`);
  }
}
map.on?.('zoomend', () => {
  for (const visual of routeVisuals) applyRouteStrokeWidths(visual);
});
function renderVehicles() {
  const selected = selectedVehicleId;
  vehicleSelect.replaceChildren(new Option('Select a virtual vehicle', ''));
  for (const vehicle of vehicles) {
    const state = vehicle.state?.simStatus || vehicle.vehicleStatus || 'READY';
    vehicleSelect.add(new Option(`${vehicle.vehicleCode}${vehicle.vehicleName ? ` · ${vehicle.vehicleName}` : ''} · ${state}`, String(vehicle.vehicleId)));
  }
  if (vehicles.some((vehicle) => String(vehicle.vehicleId) === selected)) vehicleSelect.value = selected;
  else selectedVehicleId = '';
  markerLayerGroup.clearLayers();
  for (const vehicle of vehicles) {
    const position = vehicle.state?.lastPosition;
    if (!position || !Number.isFinite(Number(position.lat)) || !Number.isFinite(Number(position.lon))) continue;
    const marker = L.circleMarker([Number(position.lat), Number(position.lon)], { radius: String(vehicle.vehicleId) === selected ? 11 : 8, color: '#6a4c93', fillColor: '#b185db', fillOpacity: 0.9 });
    marker.bindTooltip(`Virtual · ${vehicle.vehicleCode}`);
    marker.on('click', () => { selectedVehicleId = String(vehicle.vehicleId); vehicleSelect.value = selectedVehicleId; renderSelectedVehicle(vehicle); });
    markerLayerGroup.addLayer(marker);
  }
  renderSelectedVehicle(vehicles.find((vehicle) => String(vehicle.vehicleId) === selectedVehicleId));
  removeVehicleButton.disabled = !selectedVehicleId;
}
function renderSelectedVehicle(vehicle) {
  const controls = document.querySelector('#virtual-trip-controls');
  const trip = vehicle?.state?.trip;
  renderActiveTripRoute(vehicle);
  controls.hidden = !trip;
  if (!trip) return;
  const settings = vehicle.following || { autoFollowEnabled: true };
  document.querySelector('#virtual-following').checked = Boolean(settings.autoFollowEnabled);
}
function noViablePathMessage() {
  const noRouteVehicles = vehicles.filter((vehicle) => vehicle.state?.simStatus === 'NO_ROUTE'
    && vehicle.state?.blockedReason === 'No viable path after road restriction');
  if (!noRouteVehicles.length) return '';
  const labels = noRouteVehicles.map((vehicle) => vehicle.vehicleCode).join(', ');
  return `No viable path after applying this blockage${labels ? ` for ${labels}` : ''}.`;
}
function renderRequests(requests) {
  requestList.replaceChildren();
  if (!requests.length) { requestList.append(Object.assign(document.createElement('li'), { textContent: 'No pending requests.' })); return; }
  for (const request of requests) {
    const row = document.createElement('li');
    row.textContent = `Request ${request.requestId} · vehicle ${request.selectedVehicleId} · ${request.state}${request.acceptAt ? ` · ${new Date(request.acceptAt).toLocaleTimeString()}` : ''}`;
    if (request.state === 'PENDING') {
      const accept = document.createElement('button'); accept.type = 'button'; accept.textContent = 'Accept'; accept.onclick = () => decideRequest(request.requestId, 'accept');
      const reject = document.createElement('button'); reject.type = 'button'; reject.textContent = 'Reject'; reject.onclick = () => decideRequest(request.requestId, 'reject');
      row.append(' ', accept, ' ', reject);
    }
    requestList.append(row);
  }
}
function renderEvents(events) {
  if (!events.length) return;
  eventList.replaceChildren(...events.slice(-30).map((event) => {
    const li = document.createElement('li'); li.textContent = `${new Date(event.createdAt).toLocaleTimeString()} · ${event.eventType}`; return li;
  }));
  const last = events.at(-1); if (last) lastEventId = String(last.eventId);
}
async function loadScenarios() {
  const scenarios = await api('/api/v1/virtual/scenarios');
  scenarioSelect.replaceChildren(new Option('Select scenario', ''));
  scenarios.forEach((scenario) => scenarioSelect.add(new Option(`${scenario.name} · rev ${scenario.restrictionRevision}`, String(scenario.scenarioId))));
  if (!scenarios.some((scenario) => String(scenario.scenarioId) === scenarioId)) scenarioId = scenarios[0] ? String(scenarios[0].scenarioId) : '';
  const selectedScenario = scenarios.find((scenario) => String(scenario.scenarioId) === scenarioId);
  scenarioRevision = Number(selectedScenario?.restrictionRevision || 0);
  scenarioSelect.value = scenarioId;
  removeScenarioButton.disabled = !scenarioId;
  if (!scenarioId) setStatus('Create a scenario to begin.');
}
async function loadScenarioData() {
  if (!scenarioId) {
    vehicles = [];
    selectedVehicleId = '';
    renderVehicles();
    renderRequests([]);
    eventList.replaceChildren();
    return;
  }
  vehicles = await api(`/api/v1/virtual/scenarios/${scenarioId}/vehicles`);
  renderVehicles();
  renderRequests(await api(`/api/v1/virtual/scenarios/${scenarioId}/dispatch-requests`));
  const after = lastEventId ? `?after=${encodeURIComponent(lastEventId)}` : '';
  renderEvents(await api(`/api/v1/virtual/scenarios/${scenarioId}/events${after}`));
}
async function decideRequest(requestId, action) {
  try { await api(`/api/v1/virtual/dispatch-requests/${requestId}/${action}`, { method: 'POST', body: '{}' }); await loadScenarioData(); setStatus(`Request ${requestId} ${action}ed.`); }
  catch (error) { setStatus(error.message, true); }
}
async function previewRoute() {
  if (!scenarioId || !selectedVehicleId || !points.origin || !points.destination) { setStatus('Select a virtual vehicle and pick origin and destination.', true); return; }
  try {
    draft = await api(`/api/v1/virtual/scenarios/${scenarioId}/routes/preview`, { method: 'POST', body: JSON.stringify({ selectedVehicleId, origin: points.origin, destination: points.destination, waypoints: points.waypoints, expectedRestrictionRevision: scenarioRevision }) });
    renderDraft(); setStatus(`Route preview ready for vehicle ${selectedVehicleId}.`);
  } catch (error) { draft = null; renderDraft(); setStatus(error.message, true); }
}
async function generateRequest() {
  if (!draft) return;
  try { await api(`/api/v1/virtual/scenarios/${scenarioId}/dispatch-requests`, { method: 'POST', body: JSON.stringify({ draftId: String(draft.draftId), selectedVehicleId, idempotencyKey: idempotency('dispatch') }) }); setStatus('Simulated driver request generated.'); await loadScenarioData(); }
  catch (error) { setStatus(error.message, true); }
}
async function createScenario() {
  try { const scenario = await api('/api/v1/virtual/scenarios', { method: 'POST', body: JSON.stringify({ name: `Scenario ${new Date().toLocaleString()}`, autoAcceptAfterSeconds: 30 }) }); scenarioId = String(scenario.scenarioId); await loadScenarios(); await loadScenarioData(); setStatus('Scenario created.'); }
  catch (error) { setStatus(error.message, true); }
}
async function removeScenario() {
  if (!scenarioId) { setStatus('Select a scenario first.', true); return; }
  const label = scenarioSelect.selectedOptions[0]?.textContent || `Scenario ${scenarioId}`;
  if (!window.confirm(`Remove ${label}? Active trips must be cancelled first.`)) return;
  removeScenarioButton.disabled = true;
  try {
    await api(`/api/v1/virtual/scenarios/${encodeURIComponent(scenarioId)}`, { method: 'DELETE' });
    scenarioId = '';
    scenarioRevision = 0;
    selectedVehicleId = '';
    vehicles = [];
    draft = null;
    points = { origin: null, destination: null, waypoints: [] };
    restrictionCorners = [];
    restrictionGeometry = null;
    pickMode = null;
    restrictionLayerGroup.clearLayers();
    renderPoints();
    renderDraft();
    await loadScenarios();
    await loadScenarioData();
    setStatus(`${label} was removed.`);
  } catch (error) {
    removeScenarioButton.disabled = !scenarioId;
    setStatus(error.message, true);
  }
}
async function createVehicle() {
  if (!scenarioId) { setStatus('Create or select a scenario first.', true); return; }
  try { const vehicle = await api(`/api/v1/virtual/scenarios/${scenarioId}/vehicles`, { method: 'POST', body: JSON.stringify({ vehicleCode: `SIM-${Date.now()}`, vehicleName: 'Virtual vehicle', vehicleProfile: 'small', autoFollowEnabled: true }) }); selectedVehicleId = String(vehicle.vehicleId); await loadScenarioData(); setStatus('Virtual vehicle added.'); }
  catch (error) { setStatus(error.message, true); }
}
async function removeVehicle() {
  const vehicle = vehicles.find((item) => String(item.vehicleId) === selectedVehicleId);
  if (!vehicle) { setStatus('Select a virtual vehicle first.', true); return; }
  const label = vehicle.vehicleName ? `${vehicle.vehicleCode} · ${vehicle.vehicleName}` : vehicle.vehicleCode;
  if (!window.confirm(`Remove ${label} from virtual dispatch? Its completed trip history will be preserved.`)) return;
  removeVehicleButton.disabled = true;
  try {
    await api(`/api/v1/virtual/vehicles/${encodeURIComponent(selectedVehicleId)}`, { method: 'PATCH', body: JSON.stringify({ isActive: false }) });
    selectedVehicleId = '';
    draft = null;
    renderDraft();
    await loadScenarioData();
    setStatus(`${label} was removed from virtual dispatch.`);
  } catch (error) {
    setStatus(error.message, true);
    removeVehicleButton.disabled = false;
  }
}
async function setFollowing(enabled) {
  const vehicle = vehicles.find((item) => String(item.vehicleId) === selectedVehicleId);
  try { await api(`/api/v1/virtual/vehicles/${selectedVehicleId}/following`, { method: 'PUT', body: JSON.stringify({ enabled, expectedPolicyVersion: vehicle?.following?.policyVersion, idempotencyKey: idempotency('follow') }) }); await loadScenarioData(); }
  catch (error) { setStatus(error.message, true); }
}
async function command(command, extra = {}) {
  const vehicle = vehicles.find((item) => String(item.vehicleId) === selectedVehicleId);
  const tripId = vehicle?.state?.virtualTripId || vehicle?.state?.trip?.virtualTripId;
  if (!tripId) { setStatus('The selected virtual vehicle has no active trip.', true); return; }
  try { await api(`/api/v1/virtual/trips/${tripId}/commands`, { method: 'POST', body: JSON.stringify({ command, ...extra }) }); await loadScenarioData(); }
  catch (error) { setStatus(error.message, true); }
}
function selectPoint(point) {
  if (pickMode === 'origin') points.origin = point;
  else if (pickMode === 'destination') points.destination = point;
  else if (pickMode === 'waypoint') points.waypoints.push(point);
  renderPoints(); pickMode = null; setStatus('Map point recorded.');
}
function selectRestrictionPoint(point) {
  restrictionCorners.push(point);
  if (restrictionCorners.length < 2) { setStatus('Pick the opposite corner of the restriction region.'); return; }
  const [a, b] = restrictionCorners;
  const west = Math.min(a.lon, b.lon), east = Math.max(a.lon, b.lon), south = Math.min(a.lat, b.lat), north = Math.max(a.lat, b.lat);
  restrictionGeometry = { type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] };
  restrictionLayerGroup.clearLayers();
  L.rectangle([[south, west], [north, east]], { color: '#e76f51', weight: 2, fillOpacity: 0.15 }).addTo(restrictionLayerGroup);
  document.querySelector('#virtual-restriction-commit').disabled = false;
  restrictionCorners = []; pickMode = null; setStatus('Restriction region ready to activate.');
}
async function commitRestriction() {
  if (!restrictionGeometry || !scenarioId) return;
  const kind = document.querySelector('#virtual-restriction-kind').value;
  const body = { kind, geometry: restrictionGeometry, ...(kind === 'HEAVY_PENALTY' ? { penaltyFactor: Number(document.querySelector('#virtual-penalty').value) } : {}) };
  try {
    setStatus('Checking the road change and recalculating affected virtual routes…');
    const preview = await api(`/api/v1/virtual/scenarios/${scenarioId}/road-restrictions/preview`, { method: 'POST', body: JSON.stringify(body) });
    if (!preview.canActivate) { setStatus(`Blocked region is occupied by vehicle(s): ${preview.occupyingVirtualVehicleIds.join(', ')}`, true); return; }
    await api(`/api/v1/virtual/scenarios/${scenarioId}/road-restrictions`, { method: 'POST', body: JSON.stringify({ ...body, expectedRestrictionRevision: scenarioRevision }) });
    restrictionGeometry = null;
    document.querySelector('#virtual-restriction-commit').disabled = true;
    // The existing draft was calculated against the previous restriction
    // revision.  Remove it before refreshing so the map cannot keep showing
    // a route that still crosses the newly blocked region.  Re-preview an
    // idle selected vehicle automatically when the two endpoints are still
    // present; active trips are rerouted by the backend instead.
    draft = null;
    renderDraft();
    await loadScenarios();
    await loadScenarioData();
    const selected = vehicles.find((vehicle) => String(vehicle.vehicleId) === selectedVehicleId);
    const noRouteMessage = noViablePathMessage();
    if (noRouteMessage) setStatus(noRouteMessage, true);
    else if (points.origin && points.destination && selected?.vehicleStatus === 'READY') await previewRoute();
    else setStatus('Road state activated.');
  }
  catch (error) { setStatus(error.message, true); }
}
async function switchMode(next) {
  mode = next; window.__virtualMode = next === 'virtual';
  document.body.classList.toggle('virtual-mode', next === 'virtual');
  virtualPanel.hidden = next !== 'virtual';
  normalTab.setAttribute('aria-pressed', String(next === 'normal')); virtualTab.setAttribute('aria-pressed', String(next === 'virtual'));
  for (const selector of normalSections) { const element = document.querySelector(selector); if (!element) continue; if (next === 'virtual') element.hidden = true; else if (selector === '#login') element.hidden = Boolean(token()); else if (selector === '#error') element.hidden = false; }
  document.querySelector('#live-view-panel').hidden = true;
  if (next === 'virtual') {
    map.eachLayer((layer) => {
      if (layer !== routeLayerGroup && layer !== activeRouteLayerGroup && layer !== markerLayerGroup && layer !== pointLayerGroup && layer !== restrictionLayerGroup && !layer._url) map.removeLayer(layer);
    });
    try { await loadScenarios(); await loadScenarioData(); setStatus('Virtual workspace ready.'); } catch (error) { setStatus(error.message, true); }
    if (!pollTimer) pollTimer = setInterval(() => void loadScenarioData().catch((error) => setStatus(error.message, true)), 1000);
  } else {
    clearRouteGroup(routeLayerGroup); clearRouteGroup(activeRouteLayerGroup); markerLayerGroup.clearLayers(); pointLayerGroup.clearLayers(); restrictionLayerGroup.clearLayers();
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    window.__virtualMode = false;
  }
  setTimeout(() => map.invalidateSize({ pan: false }), 0);
}
map.on('click', (event) => {
  if (mode !== 'virtual' || !pickMode) return;
  const point = { lat: event.latlng.lat, lon: event.latlng.lng };
  if (pickMode === 'restriction') selectRestrictionPoint(point); else selectPoint(point);
});
normalTab.addEventListener('click', () => void switchMode('normal'));
virtualTab.addEventListener('click', () => void switchMode('virtual'));
scenarioSelect.addEventListener('change', () => { scenarioId = scenarioSelect.value; draft = null; renderDraft(); void loadScenarios().then(loadScenarioData); });
vehicleSelect.addEventListener('change', () => { selectedVehicleId = vehicleSelect.value; draft = null; renderDraft(); renderSelectedVehicle(vehicles.find((vehicle) => String(vehicle.vehicleId) === selectedVehicleId)); });
document.querySelector('#virtual-new-scenario').addEventListener('click', () => void createScenario());
removeScenarioButton.addEventListener('click', () => void removeScenario());
document.querySelector('#virtual-new-vehicle').addEventListener('click', () => void createVehicle());
removeVehicleButton.addEventListener('click', () => void removeVehicle());
document.querySelector('#virtual-preview').addEventListener('click', () => void previewRoute());
document.querySelector('#virtual-dispatch').addEventListener('click', () => void generateRequest());
document.querySelectorAll('[data-virtual-pick]').forEach((button) => button.addEventListener('click', () => { pickMode = button.dataset.virtualPick; setStatus(`Click the map to set ${pickMode}.`); }));
document.querySelector('#virtual-following').addEventListener('change', (event) => void setFollowing(event.target.checked));
document.querySelectorAll('[data-virtual-command]').forEach((button) => button.addEventListener('click', () => void command(button.dataset.virtualCommand)));
document.querySelector('#virtual-speed-apply').addEventListener('click', () => void command('SET_SPEED_FACTOR', { speedFactor: Number(document.querySelector('#virtual-speed').value) }));
document.querySelector('#virtual-restriction-pick').addEventListener('click', () => { restrictionCorners = []; pickMode = 'restriction'; setStatus('Click two opposite corners on the map.'); });
document.querySelector('#virtual-restriction-commit').addEventListener('click', () => void commitRestriction());
