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
const restrictionDraftLayerGroup = L.layerGroup().addTo(map);
const routeRenderer = L.canvas({ padding: 0.5 });
const routeVisuals = new Set();
let draftRouteSignature = '';
let activeRouteSignature = '';
const requestList = document.querySelector('#virtual-requests');
const restrictionList = document.querySelector('#virtual-restrictions');
const eventList = document.querySelector('#virtual-events');
const normalSections = ['#login', '#details', '#trip-panel', '#recordings-panel', '#error'];
let mode = 'normal';
let scenarioId = '';
let scenarioRevision = 0;
let selectedVehicleId = '';
let vehicles = [];
let restrictions = [];
let draft = null;
let points = { origin: null, destination: null, waypoints: [] };
let pickMode = null;
let restrictionCorners = [];
let restrictionGeometry = null;
let pollTimer = null;
let lastEventId = '';
let pointContextPopup = null;
const SPEED_PRESETS_KMH = [25, 50, 100, 200];
const virtualVehicleMarkers = new Map();
const virtualVehicleAnimationFrames = new Map();

function speedPresetIndex(speedKmh) {
  const numeric = Number(speedKmh);
  if (!Number.isFinite(numeric)) return 1;
  let bestIndex = 0;
  let bestDistance = Infinity;
  SPEED_PRESETS_KMH.forEach((preset, index) => {
    const distance = Math.abs(preset - numeric);
    if (distance < bestDistance) { bestDistance = distance; bestIndex = index; }
  });
  return bestIndex;
}

function selectedSpeedKmh() {
  const slider = document.querySelector('#virtual-speed');
  const index = Number(slider?.value);
  return SPEED_PRESETS_KMH[Number.isInteger(index) && index >= 0 && index < SPEED_PRESETS_KMH.length ? index : 1];
}

function renderSpeedControl(speedKmh) {
  const slider = document.querySelector('#virtual-speed');
  const output = document.querySelector('#virtual-speed-value');
  if (!slider || !output) return;
  if (speedKmh !== undefined && speedKmh !== null) slider.value = String(speedPresetIndex(speedKmh));
  output.textContent = `${selectedSpeedKmh()} km/h`;
}

function stopVehicleMarkerAnimation(vehicleId) {
  const frame = virtualVehicleAnimationFrames.get(vehicleId);
  if (frame !== undefined) cancelAnimationFrame(frame);
  virtualVehicleAnimationFrames.delete(vehicleId);
}

function clearVirtualVehicleMarkers() {
  for (const vehicleId of virtualVehicleMarkers.keys()) stopVehicleMarkerAnimation(vehicleId);
  virtualVehicleMarkers.clear();
  markerLayerGroup.clearLayers();
}

function animateVehicleMarker(vehicleId, marker, target) {
  const current = marker.getLatLng();
  const from = { lat: Number(current.lat), lon: Number(current.lng) };
  const to = { lat: Number(target.lat), lon: Number(target.lon) };
  if (![from.lat, from.lon, to.lat, to.lon].every(Number.isFinite)) return;
  stopVehicleMarkerAnimation(vehicleId);
  if (Math.abs(from.lat - to.lat) < 0.00000001 && Math.abs(from.lon - to.lon) < 0.00000001) {
    marker.setLatLng([to.lat, to.lon]);
    return;
  }
  const startedAt = performance.now();
  const durationMs = 900;
  const tick = (now) => {
    const fraction = Math.min(1, Math.max(0, (now - startedAt) / durationMs));
    const eased = fraction * fraction * (3 - 2 * fraction);
    marker.setLatLng([
      from.lat + (to.lat - from.lat) * eased,
      from.lon + (to.lon - from.lon) * eased,
    ]);
    if (fraction < 1) virtualVehicleAnimationFrames.set(vehicleId, requestAnimationFrame(tick));
    else virtualVehicleAnimationFrames.delete(vehicleId);
  };
  virtualVehicleAnimationFrames.set(vehicleId, requestAnimationFrame(tick));
}

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
function pointIcon(kind, index) {
  const variant = kind === 'origin' ? 'origin' : kind === 'destination' ? 'destination' : 'waypoint';
  const label = kind === 'origin' ? 'O' : kind === 'destination' ? 'D' : String(index + 1);
  return L.divIcon({
    className: 'virtual-point-icon',
    html: `<span class="virtual-flag virtual-flag-${variant}"><span class="virtual-flag-pole"></span><span class="virtual-flag-cloth">${label}</span><span class="virtual-flag-base"></span></span>`,
    iconSize: [40, 48],
    iconAnchor: [12, 46],
  });
}
function markPointsChanged(message) {
  draft = null;
  renderDraft();
  setStatus(message);
}
function selectedActiveTrip() {
  const vehicle = vehicles.find((item) => String(item.vehicleId) === selectedVehicleId);
  const trip = vehicle?.state?.trip;
  if (!vehicle || !trip || !vehicle.state?.virtualTripId || ['COMPLETED', 'CANCELLED'].includes(trip.state)) return null;
  return { vehicle, trip, tripId: vehicle.state.virtualTripId };
}
async function replaceActiveDestination(activeTrip, destination, previousDestination) {
  const expectedTripRevision = Number(activeTrip.trip.tripRevision);
  if (!Number.isInteger(expectedTripRevision) || expectedTripRevision < 1) {
    setStatus('The active trip revision is unavailable; refresh the virtual workspace.', true);
    return;
  }
  try {
    setStatus('Recalculating from the vehicle position to the new destination…');
    await api(`/api/v1/virtual/trips/${encodeURIComponent(activeTrip.tripId)}/destination`, {
      method: 'PUT',
      body: JSON.stringify({ destination, expectedTripRevision }),
    });
    await loadScenarioData();
    setStatus('Destination updated and optimal path recalculated.');
  } catch (error) {
    if (previousDestination) {
      points.destination = previousDestination;
      renderPoints();
    }
    setStatus(error.message, true);
  }
}
async function refreshPreviewAfterPointChange(message, kind = null, previousPoint = null) {
  markPointsChanged(`${message} Recalculating optimal path…`);
  const activeTrip = selectedActiveTrip();
  if (kind === 'destination' && activeTrip && points.destination) {
    await replaceActiveDestination(activeTrip, points.destination, previousPoint);
    return;
  }
  if (activeTrip) return;
  const selected = vehicles.find((vehicle) => String(vehicle.vehicleId) === selectedVehicleId);
  if (!points.origin || !points.destination) {
    setStatus(`${message} Set both origin and destination to calculate the path.`);
    return;
  }
  if (!scenarioId || !selectedVehicleId) {
    setStatus(`${message} Select a virtual vehicle to calculate the path.`);
    return;
  }
  if (selected?.vehicleStatus !== 'READY') {
    setStatus(`${message} The selected vehicle is not available for a new route.`, true);
    return;
  }
  await previewRoute();
}
function drawPoint(kind, point, index = 0) {
  if (!point) return;
  const marker = L.marker([point.lat, point.lon], {
    icon: pointIcon(kind, index),
    draggable: true,
    riseOnHover: true,
    autoPan: true,
  });
  marker.bindTooltip(kind === 'waypoint' ? `Waypoint ${index + 1}` : kind[0].toUpperCase() + kind.slice(1));
  marker.on('dragend', () => {
    const position = marker.getLatLng();
    const moved = { lat: position.lat, lon: position.lng };
    if (kind === 'origin') points.origin = moved;
    else if (kind === 'destination') points.destination = moved;
    else if (points.waypoints[index]) points.waypoints[index] = moved;
    renderPoints();
    void refreshPreviewAfterPointChange(`${kind === 'waypoint' ? `Waypoint ${index + 1}` : kind[0].toUpperCase() + kind.slice(1)} moved.`, kind, kind === 'destination' ? point : null);
  });
  pointLayerGroup.addLayer(marker);
}
function renderPoints() {
  pointLayerGroup.clearLayers();
  drawPoint('origin', points.origin);
  drawPoint('destination', points.destination);
  points.waypoints.forEach((point, index) => drawPoint('waypoint', point, index));
  document.querySelector('#virtual-origin').textContent = formatPoint(points.origin);
  document.querySelector('#virtual-destination').textContent = formatPoint(points.destination);
  document.querySelector('#virtual-waypoints').textContent = points.waypoints.length ? points.waypoints.map(formatPoint).join(' · ') : 'none';
}
function restrictionLabel(restriction) {
  const kind = restriction?.kind === 'HEAVY_PENALTY' ? 'Heavy penalty' : 'Blocked';
  const factor = restriction?.kind === 'HEAVY_PENALTY' && restriction?.penaltyFactor !== null && restriction?.penaltyFactor !== undefined
    ? ` · ×${Number(restriction.penaltyFactor).toFixed(1)}` : '';
  return `${kind}${factor} · revision ${restriction?.revision ?? '?'}`;
}
function renderRestrictions(items) {
  restrictions = Array.isArray(items) ? items.filter((restriction) => restriction?.isActive !== false) : [];
  restrictionLayerGroup.clearLayers();
  restrictionList.replaceChildren();
  if (!restrictions.length) {
    const empty = document.createElement('li');
    empty.textContent = 'No active regions.';
    restrictionList.append(empty);
    return;
  }
  for (const restriction of restrictions) {
    const color = restriction.kind === 'HEAVY_PENALTY' ? '#f4a261' : '#e76f51';
    if (restriction.geometry) {
      const layer = L.geoJSON(restriction.geometry, {
        style: { color, weight: 2, fillColor: color, fillOpacity: 0.16 },
      });
      layer.bindTooltip(restrictionLabel(restriction));
      restrictionLayerGroup.addLayer(layer);
    }
    const row = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = restrictionLabel(restriction);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => void removeRestriction(restriction));
    row.append(label, remove);
    restrictionList.append(row);
  }
}
function routeDisplayMetrics(style = {}) {
  return {
    // Keep these in screen pixels.  The plugin recomputes their geographic
    // positions after every map transform, while the small fixed size keeps
    // each chevron inside the colored route stroke.
    arrowFrequency: style.arrowFrequency || 42,
    arrowSize: style.arrowSize || 6.2,
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
function removeArrowheadsDeep(layer) {
  if (!layer) return;
  layer.deleteArrowheads?.();
  layer.eachLayer?.((child) => removeArrowheadsDeep(child));
}
function clearRouteGroup(group) {
  // leaflet-arrowheads keeps its generated polygons on the child polyline.
  // Remove those explicitly before clearing the GeoJSON group so a refresh
  // cannot leave an old set of arrows behind for the next zoom/update.
  for (const visual of routeVisuals) {
    if (visual.group !== group) continue;
    removeArrowheadsDeep(visual.line);
    removeArrowheadsDeep(visual.arrowLine);
    removeArrowheadsDeep(visual.outline);
    visual.line.remove?.();
    visual.arrowLine?.remove?.();
    visual.outline.remove?.();
    routeVisuals.delete(visual);
  }
  group.clearLayers();
}
function arrowheadOptions(style) {
  if (style.showArrows === false || typeof L.Polyline?.prototype.arrowheads !== 'function') return null;
  const metrics = routeDisplayMetrics(style);
  return {
    color: style.arrowColor || '#ffffff',
    fillColor: style.arrowColor || '#ffffff',
    fill: true,
    weight: style.arrowWeight ?? 0.8,
    opacity: style.arrowOpacity ?? 0.98,
    fillOpacity: style.arrowFillOpacity ?? style.arrowOpacity ?? 1,
    // A smaller yawn makes a narrower, sharper chevron that stays inside
    // the inner route stroke instead of spilling over its edges.
    yawn: style.arrowYawn ?? 36,
    size: `${metrics.arrowSize.toFixed(1)}px`,
    frequency: `${metrics.arrowFrequency.toFixed(1)}px`,
  };
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
  const arrows = arrowheadOptions(style);
  if (arrows && !style.arrowGeometry) lineOptions.arrowheads = arrows;
  const line = L.geoJSON(routeGeojson, lineOptions).addTo(group);
  let arrowLine = null;
  if (arrows && style.arrowGeometry) {
    // Keep the complete previous route visible, but put its chevrons on a
    // filtered geometry so shared road segments do not receive a second set
    // of arrows from the current route.
    arrowLine = L.geoJSON(style.arrowGeometry, {
      style: {
        color: style.arrowColor || '#ffffff',
        weight: 0,
        opacity: 0,
        lineCap: 'round',
        lineJoin: 'round',
        renderer: routeRenderer,
      },
      arrowheads: arrows,
    }).addTo(group);
  }
  if (tooltip) line.bindTooltip(tooltip);
  const visual = { group, outline, line, arrowLine, style };
  routeVisuals.add(visual);
  applyRouteStrokeWidths(visual);
}
function routeIdentity(route) {
  if (!route) return '';
  // Route rows are immutable snapshots.  Prefer their database id and keep
  // the version as a fallback for responses that omit the id.
  return String(route.routeId ?? `v${route.routeVersion ?? ''}`);
}
function routeGeometryIdentity(routeGeojson) {
  if (!routeGeojson) return '';
  try { return JSON.stringify(routeGeojson); } catch { return ''; }
}
function routeLineCoordinates(routeGeojson) {
  const geometry = routeGeojson?.type === 'Feature' ? routeGeojson.geometry : routeGeojson;
  if (geometry?.type === 'LineString' && Array.isArray(geometry.coordinates)) return [geometry.coordinates];
  if (geometry?.type === 'MultiLineString' && Array.isArray(geometry.coordinates)) return geometry.coordinates;
  if (routeGeojson?.type === 'FeatureCollection' && Array.isArray(routeGeojson.features)) {
    return routeGeojson.features.flatMap((feature) => routeLineCoordinates(feature));
  }
  return [];
}
function coordinateIdentity(coordinate) {
  if (!Array.isArray(coordinate) || coordinate.length < 2) return '';
  const lon = Number(coordinate[0]);
  const lat = Number(coordinate[1]);
  return Number.isFinite(lon) && Number.isFinite(lat) ? `${lon.toFixed(6)},${lat.toFixed(6)}` : '';
}
function segmentIdentity(a, b) {
  const first = coordinateIdentity(a);
  const second = coordinateIdentity(b);
  if (!first || !second) return '';
  return first < second ? `${first}|${second}` : `${second}|${first}`;
}
function routeArrowGeometryExcluding(routeGeojson, excludedGeojson) {
  const sourceLines = routeLineCoordinates(routeGeojson);
  const excludedSegments = new Set();
  for (const line of routeLineCoordinates(excludedGeojson)) {
    for (let index = 1; index < line.length; index += 1) {
      const identity = segmentIdentity(line[index - 1], line[index]);
      if (identity) excludedSegments.add(identity);
    }
  }
  if (!sourceLines.length || !excludedSegments.size) return routeGeojson;
  const remainingLines = [];
  for (const line of sourceLines) {
    let run = [];
    const flush = () => {
      if (run.length >= 2) remainingLines.push(run);
      run = [];
    };
    for (let index = 1; index < line.length; index += 1) {
      const start = line[index - 1];
      const end = line[index];
      if (excludedSegments.has(segmentIdentity(start, end))) {
        flush();
        continue;
      }
      if (!run.length) run.push(start);
      run.push(end);
    }
    flush();
  }
  if (!remainingLines.length) return null;
  if (remainingLines.length === 1) return { type: 'LineString', coordinates: remainingLines[0] };
  return {
    type: 'FeatureCollection',
    features: remainingLines.map((coordinates) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } })),
  };
}
function renderDraft() {
  if (!draft) {
    if (draftRouteSignature) clearRouteGroup(routeLayerGroup);
    draftRouteSignature = '';
    document.querySelector('#virtual-draft-summary').textContent = 'No route draft.';
    document.querySelector('#virtual-dispatch').disabled = true;
    return;
  }
  const signature = String(draft.draftId ?? JSON.stringify(draft.routeGeojson ?? draft.route ?? ''));
  if (signature === draftRouteSignature) return;
  draftRouteSignature = signature;
  clearRouteGroup(routeLayerGroup);
  addRouteVisual(routeLayerGroup, draft.routeGeojson, {
    outlineColor: '#493b5d', outlineWeight: 14, outlineOpacity: 0.78,
    lineColor: '#7c3aed', lineWeight: 11, lineOpacity: 0.98, arrowColor: '#ffffff', arrowYawn: 36, showArrows: true,
  }, 'Route preview');
  document.querySelector('#virtual-draft-summary').textContent = `Draft ${draft.draftId} · ${(Number(draft.distanceM || draft.route?.distanceM || 0) / 1000).toFixed(2)} km · ${(Number(draft.durationSec || draft.route?.durationSec || 0) / 60).toFixed(1)} min · restriction revision ${draft.restrictionRevision}`;
  document.querySelector('#virtual-dispatch').disabled = false;
}
function renderActiveTripRoute(vehicle) {
  const trip = vehicle?.state?.trip;
  const routes = Array.isArray(trip?.routes) ? trip.routes.filter((route) => route?.routeGeojson) : [];
  if (!routes.length) {
    if (activeRouteSignature) clearRouteGroup(activeRouteLayerGroup);
    activeRouteSignature = '';
    return;
  }
  // The state row is the authoritative active-route pointer.  Prefer it over
  // the historical isCurrent flag so a just-completed reroute is displayed
  // even if a concurrent refresh briefly leaves more than one snapshot marked
  // current.
  const activeRouteId = vehicle?.state?.activeRouteId;
  const currentRoute = routes.find((route) => activeRouteId !== null && activeRouteId !== undefined
    && String(route.routeId) === String(activeRouteId))
    || routes.find((route) => route.isCurrent)
    || routes.at(-1);
  const previousRoute = routes
    .filter((route) => route !== currentRoute)
    .sort((a, b) => Number(b.routeVersion || 0) - Number(a.routeVersion || 0))[0];
  const signature = [
    vehicle?.vehicleId ?? '',
    trip?.virtualTripId ?? vehicle?.state?.virtualTripId ?? '',
    routeIdentity(previousRoute),
    routeIdentity(currentRoute),
  ].join('|');
  // Scenario polling runs once per second.  Keep the existing Leaflet layers
  // when the route snapshot is unchanged; rebuilding arrowheads on every poll
  // is what caused duplicate markers and visible flicker.
  if (signature === activeRouteSignature) return;
  activeRouteSignature = signature;
  clearRouteGroup(activeRouteLayerGroup);
  const currentGeometry = routeGeometryIdentity(currentRoute?.routeGeojson);
  const previousArrowGeometry = previousRoute
    ? routeArrowGeometryExcluding(previousRoute.routeGeojson, currentRoute?.routeGeojson)
    : null;
  for (const route of [previousRoute, currentRoute].filter(Boolean)) {
    // Use the route selected above for both ordering and styling.  During a
    // reroute the state row can point at the new route before the historical
    // snapshot's isCurrent flag is visible in the same response; styling from
    // that stale flag would make the active route look like the dim previous
    // route and make the new path appear to be missing.
    const current = route === currentRoute;
    const duplicateGeometry = !current && currentGeometry !== ''
      && routeGeometryIdentity(route.routeGeojson) === currentGeometry;
    addRouteVisual(activeRouteLayerGroup, route.routeGeojson, current
      ? { outlineColor: '#23415f', outlineWeight: 14, outlineOpacity: 0.82, lineColor: '#0875f5', lineWeight: 11, lineOpacity: 1, arrowColor: '#ffffff', arrowOpacity: 0.98, arrowYawn: 36, showArrows: true }
      : { outlineColor: '#59452b', outlineWeight: 12, outlineOpacity: 0.62, lineColor: '#f59e0b', lineWeight: 9, lineOpacity: 0.72, arrowColor: '#ffffff', arrowOpacity: 0.62, arrowYawn: 36, showArrows: !duplicateGeometry && Boolean(previousArrowGeometry), arrowGeometry: previousArrowGeometry },
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
  if (draft) {
    const draftVehicleId = String(draft.selectedVehicleId ?? selectedVehicleId);
    const draftVehicle = vehicles.find((vehicle) => String(vehicle.vehicleId) === draftVehicleId);
    const hasActiveTrip = Boolean(draftVehicle?.state?.virtualTripId || draftVehicle?.state?.trip?.virtualTripId);
    if (hasActiveTrip) {
      // Once a preview has become an active trip, its route is rendered by
      // the active-trip layer. Keeping the draft layer would draw a second
      // set of arrowheads on the same geometry.
      draft = null;
      renderDraft();
    }
  }
  const visibleVehicleIds = new Set();
  for (const vehicle of vehicles) {
    const position = vehicle.state?.lastPosition;
    if (!position || !Number.isFinite(Number(position.lat)) || !Number.isFinite(Number(position.lon))) continue;
    const vehicleId = String(vehicle.vehicleId);
    visibleVehicleIds.add(vehicleId);
    let marker = virtualVehicleMarkers.get(vehicleId);
    if (!marker) {
      marker = L.circleMarker([Number(position.lat), Number(position.lon)], { radius: vehicleId === selected ? 11 : 8, color: '#6a4c93', fillColor: '#b185db', fillOpacity: 0.9 });
      marker.bindTooltip(`Virtual · ${vehicle.vehicleCode}`);
      marker.on('click', () => { selectedVehicleId = vehicleId; vehicleSelect.value = selectedVehicleId; renderSelectedVehicle(vehicles.find((item) => String(item.vehicleId) === vehicleId)); });
      virtualVehicleMarkers.set(vehicleId, marker);
      markerLayerGroup.addLayer(marker);
    } else {
      animateVehicleMarker(vehicleId, marker, { lat: Number(position.lat), lon: Number(position.lon) });
      marker.setStyle({ radius: vehicleId === selected ? 11 : 8 });
      marker.setTooltipContent(`Virtual · ${vehicle.vehicleCode}`);
    }
  }
  for (const [vehicleId, marker] of virtualVehicleMarkers) {
    if (visibleVehicleIds.has(vehicleId)) continue;
    stopVehicleMarkerAnimation(vehicleId);
    markerLayerGroup.removeLayer(marker);
    virtualVehicleMarkers.delete(vehicleId);
  }
  renderSelectedVehicle(vehicles.find((vehicle) => String(vehicle.vehicleId) === selectedVehicleId));
  removeVehicleButton.disabled = !selectedVehicleId;
}
function renderSelectedVehicle(vehicle) {
  const controls = document.querySelector('#virtual-trip-controls');
  const trip = vehicle?.state?.trip;
  renderActiveTripRoute(vehicle);
  controls.hidden = !trip;
  if (!trip) { renderSpeedControl(); return; }
  const settings = vehicle.following || { autoFollowEnabled: true };
  document.querySelector('#virtual-following').checked = Boolean(settings.autoFollowEnabled);
  renderSpeedControl(vehicle.state?.speedKmh);
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
    renderRestrictions([]);
    renderVehicles();
    renderRequests([]);
    eventList.replaceChildren();
    return;
  }
  const [scenario, scenarioVehicles, requests, events] = await Promise.all([
    api(`/api/v1/virtual/scenarios/${scenarioId}`),
    api(`/api/v1/virtual/scenarios/${scenarioId}/vehicles`),
    api(`/api/v1/virtual/scenarios/${scenarioId}/dispatch-requests`),
    api(`/api/v1/virtual/scenarios/${scenarioId}/events${lastEventId ? `?after=${encodeURIComponent(lastEventId)}` : ''}`),
  ]);
  scenarioRevision = Number(scenario?.restrictionRevision || 0);
  renderRestrictions(scenario?.restrictions);
  vehicles = scenarioVehicles;
  renderVehicles();
  renderRequests(requests);
  renderEvents(events);
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
    restrictionDraftLayerGroup.clearLayers();
    renderRestrictions([]);
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
  try { const vehicle = await api(`/api/v1/virtual/scenarios/${scenarioId}/vehicles`, { method: 'POST', body: JSON.stringify({ vehicleCode: `SIM-${Date.now()}`, vehicleName: 'Virtual vehicle', vehicleProfile: 'small', autoFollowEnabled: true }) }); selectedVehicleId = String(vehicle.vehicleId); await loadScenarioData(); setStatus('Virtual vehicle added.'); if (points.origin && points.destination) await refreshPreviewAfterPointChange('Vehicle added.'); }
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
function closePointContextMenu() {
  if (!pointContextPopup) return;
  map.closePopup(pointContextPopup);
  pointContextPopup = null;
}
function setPointFromContext(action, point) {
  const previousDestination = action === 'destination' ? points.destination : null;
  if (action === 'origin') points.origin = point;
  else if (action === 'destination') points.destination = point;
  else if (action === 'waypoint') points.waypoints.push(point);
  renderPoints();
  closePointContextMenu();
  void refreshPreviewAfterPointChange(action === 'waypoint' ? `Waypoint ${points.waypoints.length} added.` : `${action[0].toUpperCase() + action.slice(1)} set.`, action, previousDestination);
}
function showPointContextMenu(event) {
  if (mode !== 'virtual') return;
  event.originalEvent?.preventDefault();
  if (pickMode === 'restriction') {
    setStatus('Finish the restriction region first.');
    return;
  }
  const point = { lat: event.latlng.lat, lon: event.latlng.lng };
  const content = document.createElement('div');
  content.className = 'virtual-map-context-menu';
  const title = document.createElement('strong');
  title.textContent = 'Set route point';
  content.append(title);
  const actions = [
    ['origin', 'Set origin here'],
    ['destination', 'Set destination here'],
    ['waypoint', `Add waypoint ${points.waypoints.length + 1} here`],
  ];
  for (const [action, label] of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => setPointFromContext(action, point));
    content.append(button);
  }
  closePointContextMenu();
  pointContextPopup = L.popup({ closeButton: true, closeOnClick: true, autoClose: true, className: 'virtual-map-context-popup', offset: [0, -8] })
    .setLatLng(event.latlng)
    .setContent(content)
    .openOn(map);
}
function selectRestrictionPoint(point) {
  restrictionCorners.push(point);
  if (restrictionCorners.length < 2) { setStatus('Pick the opposite corner of the restriction region.'); return; }
  const [a, b] = restrictionCorners;
  const west = Math.min(a.lon, b.lon), east = Math.max(a.lon, b.lon), south = Math.min(a.lat, b.lat), north = Math.max(a.lat, b.lat);
  restrictionGeometry = { type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] };
  restrictionDraftLayerGroup.clearLayers();
  L.rectangle([[south, west], [north, east]], { color: '#e76f51', weight: 2, fillOpacity: 0.15 }).addTo(restrictionDraftLayerGroup);
  document.querySelector('#virtual-restriction-commit').disabled = false;
  restrictionCorners = []; pickMode = null; setStatus('Restriction region ready to activate.');
}
async function refreshAfterRestrictionChange(message) {
  draft = null;
  renderDraft();
  await loadScenarios();
  await loadScenarioData();
  const selected = vehicles.find((vehicle) => String(vehicle.vehicleId) === selectedVehicleId);
  const noRouteMessage = noViablePathMessage();
  if (noRouteMessage) setStatus(noRouteMessage, true);
  else if (points.origin && points.destination && selected?.vehicleStatus === 'READY') await previewRoute();
  else setStatus(message);
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
    restrictionDraftLayerGroup.clearLayers();
    document.querySelector('#virtual-restriction-commit').disabled = true;
    // The existing draft was calculated against the previous restriction
    // revision.  Remove it before refreshing so the map cannot keep showing
    // a route that still crosses the newly blocked region.  Re-preview an
    // idle selected vehicle automatically when the two endpoints are still
    // present; active trips are rerouted by the backend instead.
    await refreshAfterRestrictionChange('Road state activated.');
  }
  catch (error) { setStatus(error.message, true); }
}
async function removeRestriction(restriction) {
  if (!scenarioId || !restriction?.restrictionId) return;
  const label = restrictionLabel(restriction);
  if (!window.confirm(`Remove ${label}? Routes will be recalculated.`)) return;
  try {
    setStatus(`Removing ${label} and recalculating affected virtual routes…`);
    await api(`/api/v1/virtual/road-restrictions/${encodeURIComponent(restriction.restrictionId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive: false, expectedRestrictionRevision: scenarioRevision }),
    });
    await refreshAfterRestrictionChange('Road region removed.');
  } catch (error) { setStatus(error.message, true); }
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
      if (layer !== routeLayerGroup && layer !== activeRouteLayerGroup && layer !== markerLayerGroup && layer !== pointLayerGroup && layer !== restrictionLayerGroup && layer !== restrictionDraftLayerGroup && !layer._url) map.removeLayer(layer);
    });
    try { await loadScenarios(); await loadScenarioData(); setStatus('Virtual workspace ready.'); } catch (error) { setStatus(error.message, true); }
    if (!pollTimer) pollTimer = setInterval(() => void loadScenarioData().catch((error) => setStatus(error.message, true)), 1000);
  } else {
    clearRouteGroup(routeLayerGroup); clearRouteGroup(activeRouteLayerGroup); clearVirtualVehicleMarkers(); pointLayerGroup.clearLayers(); restrictionLayerGroup.clearLayers(); restrictionDraftLayerGroup.clearLayers();
    draftRouteSignature = '';
    activeRouteSignature = '';
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    window.__virtualMode = false;
  }
  setTimeout(() => map.invalidateSize({ pan: false }), 0);
}
map.on('click', (event) => {
  if (mode !== 'virtual' || !pickMode) return;
  const point = { lat: event.latlng.lat, lon: event.latlng.lng };
  if (pickMode === 'restriction') selectRestrictionPoint(point);
});
map.on('contextmenu', (event) => showPointContextMenu(event));
normalTab.addEventListener('click', () => void switchMode('normal'));
virtualTab.addEventListener('click', () => void switchMode('virtual'));
scenarioSelect.addEventListener('change', () => { scenarioId = scenarioSelect.value; draft = null; renderDraft(); void loadScenarios().then(loadScenarioData); });
vehicleSelect.addEventListener('change', () => {
  selectedVehicleId = vehicleSelect.value;
  draft = null;
  renderDraft();
  renderSelectedVehicle(vehicles.find((vehicle) => String(vehicle.vehicleId) === selectedVehicleId));
  if (points.origin && points.destination) void refreshPreviewAfterPointChange('Vehicle selected.');
});
document.querySelector('#virtual-new-scenario').addEventListener('click', () => void createScenario());
removeScenarioButton.addEventListener('click', () => void removeScenario());
document.querySelector('#virtual-new-vehicle').addEventListener('click', () => void createVehicle());
removeVehicleButton.addEventListener('click', () => void removeVehicle());
document.querySelector('#virtual-preview').addEventListener('click', () => void previewRoute());
document.querySelector('#virtual-dispatch').addEventListener('click', () => void generateRequest());
document.querySelector('#virtual-following').addEventListener('change', (event) => void setFollowing(event.target.checked));
document.querySelectorAll('[data-virtual-command]').forEach((button) => button.addEventListener('click', () => void command(button.dataset.virtualCommand)));
document.querySelector('#virtual-speed').addEventListener('input', () => renderSpeedControl());
document.querySelector('#virtual-speed-apply').addEventListener('click', () => void command('SET_SPEED_KMH', { speedKmh: selectedSpeedKmh() }));
document.querySelector('#virtual-restriction-pick').addEventListener('click', () => { restrictionCorners = []; pickMode = 'restriction'; setStatus('Click two opposite corners on the map.'); });
document.querySelector('#virtual-restriction-commit').addEventListener('click', () => void commitRestriction());
