import {uiText, applyRoadHatch, vehicleIcon} from './dashboard-ui.js';
/* Dedicated virtual routing workspace. It owns its own layers and state so
 * virtual vehicles never enter the normal tracking/live/replay selection path. */
import { createSectionVisibility } from './workspace-sections.js';
import { installRoadBrush } from './road-brush.js';

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
const endpointSnapPreviewLayerGroup = L.layerGroup().addTo(map);
// Draw all nearby roads as one path, then erase all their interiors together.
// This merges intersecting road outlines without painting borders back over
// an adjacent road's cleared interior. Only this overlay's canvas is erased.
const RoadOutlineRenderer = L.Canvas.extend({
  _fillStroke(ctx, layer) {
    L.Canvas.prototype._fillStroke.call(this, ctx, layer);
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 1;
    ctx.lineWidth = 10;
    ctx.stroke();
    ctx.restore();
  },
});
const endpointRoadOutlineRenderer = new RoadOutlineRenderer({ padding: 0.5 });
const snapPreviewPane = map.createPane('snapPreviewPane');
snapPreviewPane.style.zIndex = '640';
snapPreviewPane.style.pointerEvents = 'none';
const endpointSnapCircleRenderer = L.svg({ pane: 'snapPreviewPane' });
const restrictionLayerGroup = L.layerGroup().addTo(map);
const routeContextMenu = document.createElement('div');
routeContextMenu.className = 'virtual-route-context-menu';
routeContextMenu.setAttribute('role', 'menu');
routeContextMenu.setAttribute('aria-label', '경로 및 도로 차단');
routeContextMenu.hidden = true;
routeContextMenu.innerHTML = '<div class="route-point-menu-row"><button type="button" role="menuitem" data-route-point-kind="origin"><span aria-hidden="true" class="route-point-menu-icon origin">O</span><span>출발</span></button><button type="button" role="menuitem" data-route-point-kind="destination"><span aria-hidden="true" class="route-point-menu-icon destination">D</span><span>도착</span></button><button type="button" role="menuitem" data-route-point-kind="waypoint"><span aria-hidden="true" class="route-point-menu-icon waypoint">＋</span><span>경유지</span></button></div><div class="road-brush-heading"><span class="route-point-menu-icon destination" aria-hidden="true">⊘</span><span>차단</span></div><div class="road-brush-submenu"><button type="button" role="menuitem" data-road-tool="paint">브러시</button><button type="button" role="menuitem" data-road-tool="erase">지우개</button></div>';
map.getContainer().append(routeContextMenu);
const routingLogOverlay = document.createElement('section');
routingLogOverlay.className = 'virtual-routing-log';
routingLogOverlay.setAttribute('role', 'log');
routingLogOverlay.setAttribute('aria-live', 'polite');
routingLogOverlay.hidden = true;
routingLogOverlay.innerHTML = '<header><strong>라우팅 로그</strong><div><button type="button" data-copy-routing-log>복사</button><button type="button" data-clear-routing-log aria-label="로그 지우기">지우기</button></div></header><ol></ol>';
map.getContainer().append(routingLogOverlay);
const routingLogList = routingLogOverlay.querySelector('ol');
const noRouteAlarm = document.createElement('section');
noRouteAlarm.className = 'virtual-no-route-alarm';
noRouteAlarm.setAttribute('role', 'alert');
noRouteAlarm.setAttribute('aria-live', 'assertive');
noRouteAlarm.hidden = true;
noRouteAlarm.innerHTML = '<span class="virtual-no-route-alarm-icon" aria-hidden="true">!</span><div><strong>경로 없음</strong><p data-no-route-message></p></div><button type="button" aria-label="경고 닫기" title="경고 닫기">×</button>';
map.getContainer().append(noRouteAlarm);
const noRouteAlarmMessage = noRouteAlarm.querySelector('[data-no-route-message]');
const noRouteAlarmDismiss = noRouteAlarm.querySelector('button');
const seenNoRouteKeys = new Set();
noRouteAlarmDismiss.addEventListener('click', () => { noRouteAlarm.hidden = true; });
function showNoRouteAlarm(vehicleId, tripId, message) {
  const vehicle = vehicles.find((item) => String(item.vehicleId) === String(vehicleId));
  const label = vehicle?.vehicleCode || `차량 ${vehicleId}`;
  noRouteAlarm.dataset.key = `${scenarioId}:${vehicleId}:${tripId || ''}`;
  noRouteAlarmMessage.textContent = `${label}${tripId ? ` · 운행 ${tripId}` : ''} — ${message || '차단 구간을 피해 갈 수 있는 경로를 찾지 못했습니다.'}`;
  noRouteAlarm.hidden = false;
}
function syncNoRouteAlarms() {
  const currentKeys = new Set();
  for (const vehicle of vehicles) {
    if (vehicle.state?.simStatus !== 'NO_ROUTE' || ![
      'No viable path after road restriction',
      'No legal route under the current road state',
    ].includes(vehicle.state?.blockedReason)) continue;
    const tripId = vehicle.state.virtualTripId || vehicle.state.trip?.virtualTripId || '';
    const key = `${scenarioId}:${vehicle.vehicleId}:${tripId}`;
    currentKeys.add(key);
    if (!seenNoRouteKeys.has(key)) {
      seenNoRouteKeys.add(key);
      showNoRouteAlarm(vehicle.vehicleId, tripId, '차단 구간을 피해 갈 수 있는 경로를 찾지 못했습니다.');
    }
  }
  for (const key of seenNoRouteKeys) if (!currentKeys.has(key)) seenNoRouteKeys.delete(key);
  if (noRouteAlarm.dataset.key && !currentKeys.has(noRouteAlarm.dataset.key)) {
    noRouteAlarm.hidden = true;
    noRouteAlarm.dataset.key = '';
  }
}
const routeProgressIndicator = document.createElement('div');
routeProgressIndicator.className = 'virtual-route-progress';
routeProgressIndicator.setAttribute('role', 'status');
routeProgressIndicator.setAttribute('aria-live', 'polite');
routeProgressIndicator.hidden = true;
routeProgressIndicator.innerHTML = '<span class="virtual-route-progress-spinner" aria-hidden="true"></span><span data-route-progress-message>경로를 계산하는 중…</span>';
map.getContainer().append(routeProgressIndicator);
const routeProgressMessage = routeProgressIndicator.querySelector('[data-route-progress-message]');
const routeOperations = new Map();
let routeCalculationController = null;
function cancelInFlightRouteCalculation() {
  routeCalculationController?.abort();
  routeCalculationController = null;
}
function syncRouteProgress() {
  const busy = routeOperations.size > 0;
  routeProgressIndicator.hidden = !busy;
  map.getContainer().classList.toggle('route-calculating', busy);
  routeProgressMessage.textContent = [...routeOperations.values()].at(-1) || '경로를 계산하는 중…';
  routeContextMenu.querySelectorAll('button').forEach((button) => { button.disabled = busy; });
  restrictionList.querySelectorAll('button').forEach((button) => { button.disabled = busy; });
}
function beginRouteCalculation(message = '경로를 계산하는 중…') {
  const operation = Symbol('route calculation');
  routeOperations.set(operation, message);
  hideRouteContextMenu();
  syncRouteProgress();
  return () => {
    routeOperations.delete(operation);
    syncRouteProgress();
  };
}
async function copyRoutingText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const field = document.createElement('textarea');
  field.value = text;
  field.style.position = 'fixed'; field.style.opacity = '0';
  document.body.append(field);
  try {
    field.select();
    if (!document.execCommand('copy')) throw new Error('Clipboard copy failed');
  } finally { field.remove(); }
}
routingLogOverlay.querySelector('[data-copy-routing-log]').addEventListener('click', async () => {
  const text = [...routingLogList.querySelectorAll('[data-routing-log-text]')].map(item => item.textContent).join('\n');
  try {
    await copyRoutingText(text);
    setStatus('라우팅 로그를 복사했습니다.');
  } catch { setStatus('라우팅 로그를 복사하지 못했습니다.', true); }
});
routingLogOverlay.querySelector('[data-clear-routing-log]').addEventListener('click', () => {
  routingLogList.replaceChildren();
  routingLogOverlay.hidden = true;
});
routingLogOverlay.addEventListener('click', event => event.stopPropagation());
function showRoutingLog(message, details = null, context = {}) {
  routingLogOverlay.hidden = false;
  const item = document.createElement('li');
  const stopIndex = details?.stopIndex ?? details?.detail?.stopIndex;
  const leg = Number.isInteger(stopIndex) ? `도착 순번 ${stopIndex}로 향하는 구간` : '경로 계산';
  const vehicle = context.vehicleId ? `차량 ${context.vehicleId} · ` : '';
  const trip = context.tripId ? `운행 ${context.tripId} · ` : '';
  const edgeCount = Number.isInteger(context.blockedDirectedEdgeCount) ? ` · 차단 edge ${context.blockedDirectedEdgeCount}개` : '';
  const noRoute = context.stateChangedToNoRoute ? ' · NO_ROUTE 전환' : '';
  const text = document.createElement('span');
  text.dataset.routingLogText = 'true';
  text.textContent = `${new Date().toLocaleTimeString()} · ${vehicle}${trip}${leg} 실패: ${message}${edgeCount}${noRoute}`;
  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'virtual-routing-log-copy';
  copyButton.setAttribute('aria-label', '이 로그 복사');
  copyButton.title = '이 로그 복사';
  copyButton.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6.5" y="6.5" width="10" height="11" rx="1.5"/><path d="M13.5 6V4.8A1.8 1.8 0 0 0 11.7 3H4.8A1.8 1.8 0 0 0 3 4.8v8.4A1.8 1.8 0 0 0 4.8 15H6"/></svg>';
  copyButton.addEventListener('click', async () => {
    try { await copyRoutingText(text.textContent); setStatus('로그 메시지를 복사했습니다.'); }
    catch { setStatus('로그 메시지를 복사하지 못했습니다.', true); }
  });
  item.append(text, copyButton);
  routingLogList.prepend(item);
  while (routingLogList.children.length > 6) routingLogList.lastElementChild.remove();
}
let contextRoutePoint = null;
const routeRenderer = L.canvas({ padding: 0.5 });
const routeVisuals = new Set();
let draftRouteSignature = '';
let activeRouteSignature = '';
const requestList = document.querySelector('#virtual-requests');
const restrictionList = document.querySelector('#virtual-restrictions');
const eventList = document.querySelector('#virtual-events');
const normalSections = ['#login', '#selection-empty', '#details', '#telemetry-settings', '#trip-panel', '#recordings-panel', '#error'];
const normalSectionVisibility = createSectionVisibility(
  normalSections.map((selector) => document.querySelector(selector)).filter(Boolean),
);
let mode = 'normal';
let scenarioId = '';
let scenarioRevision = 0;
let selectedVehicleId = '';
let speedControlEditing = false;
let pendingSpeedChange = null;
let applyingSpeedChange = false;
let vehicles = [];
let restrictions = [];
let draft = null;
let dispatchSubmitting = false;
let points = { origin: null, destination: null, waypoints: [] };
let pickMode = null;
let pointPlacement = null;
let movingPin = null;
let endpointDrag = null;
let pollTimer = null;
let vehiclePollTimer = null;
let lastEventId = '';
let eventScenarioId = '';
let hasLoadedEvents = false;
const SPEED_PRESETS_KMH = [25, 50, 100, 200];
const virtualVehicleMarkers = new Map();
const virtualVehicleAnimationFrames = new Map();
const roadBrush = installRoadBrush(map, {
  isActive: () => mode === 'virtual' && Boolean(scenarioId),
  onStatus: setStatus,
  async onStroke(stroke) {
    const finishRouting = beginRouteCalculation(stroke.mode === 'paint' ? '차단 구간을 적용하고 경로를 다시 계산하는 중…' : '차단 구간을 해제하고 경로를 다시 계산하는 중…');
    const targetScenario = scenarioId;
    setStatus(stroke.mode === 'paint' ? '도로 차단을 적용하는 중…' : '도로 차단을 지우는 중…');
    try {
      const result = await api(`/api/v1/virtual/scenarios/${encodeURIComponent(targetScenario)}/road-restrictions/brush`, {
        method: 'POST', body: JSON.stringify({ ...stroke, expectedRestrictionRevision: scenarioRevision }),
      });
      if (scenarioId !== targetScenario || mode !== 'virtual') return;
      scenarioRevision = result.restrictionRevision;
      for (const failure of result.routingFailures || []) {
        showRoutingLog(failure.message || failure.code || '경로 계산에 실패했습니다.', failure.details, failure);
        if (failure.stateChangedToNoRoute) {
          const key = `${targetScenario}:${failure.vehicleId}:${failure.tripId}`;
          seenNoRouteKeys.add(key);
          showNoRouteAlarm(failure.vehicleId, failure.tripId, '차단 구간을 피해 갈 수 있는 경로를 찾지 못했습니다.');
        }
      }
      await refreshAfterRestrictionChange(stroke.mode === 'paint' ? '도로 차단을 적용했습니다.' : '지운 영역의 도로 차단을 해제했습니다.');
    } catch (error) {
      if (scenarioId !== targetScenario || mode !== 'virtual') return;
      try { await loadScenarioData(); } catch {}
      throw error;
    } finally {
      finishRouting();
    }
  },
});
window.__operatorRoadBrushPointerDown = roadBrush.handleMouseDown;


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
  let displayedSpeed = selectedSpeedKmh();
  const currentSpeed = Number(speedKmh);
  if (!speedControlEditing && Number.isFinite(currentSpeed) && currentSpeed > 0) {
    slider.value = String(speedPresetIndex(currentSpeed));
    displayedSpeed = currentSpeed;
  }
  output.textContent = `${displayedSpeed} km/h`;
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
  const durationMs = 300;
  const tick = (now) => {
    const fraction = Math.min(1, Math.max(0, (now - startedAt) / durationMs));
    marker.setLatLng([
      from.lat + (to.lat - from.lat) * fraction,
      from.lon + (to.lon - from.lon) * fraction,
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
  if (!response.ok) {
    const error = new Error(body.error?.message || body.detail?.message || body.detail || `HTTP ${response.status}`);
    error.code = body.error?.code || body.detail?.code;
    error.details = body.error?.details || body.detail;
    throw error;
  }
  return body.data ?? body;
}
function setStatus(message, isError = false) {
  status.textContent = message;
  status.dataset.level = isError ? 'error' : 'info';
}
function hideRouteContextMenu() {
  routeContextMenu.hidden = true;
  contextRoutePoint = null;
}
function showRouteContextMenu({ clientX, clientY }) {
  if (mode !== 'virtual' || routeOperations.size > 0) return;
  const container = map.getContainer();
  const bounds = container.getBoundingClientRect();
  contextRoutePoint = map.mouseEventToLatLng({ clientX, clientY });
  routeContextMenu.hidden = false;
  const maxLeft = Math.max(8, container.clientWidth - routeContextMenu.offsetWidth - 8);
  const maxTop = Math.max(8, container.clientHeight - routeContextMenu.offsetHeight - 8);
  routeContextMenu.style.left = `${Math.max(8, Math.min(clientX - bounds.left, maxLeft))}px`;
  routeContextMenu.style.top = `${Math.max(8, Math.min(clientY - bounds.top, maxTop))}px`;
  routeContextMenu.querySelector('button')?.focus();
}
function idempotency(prefix) { return `${prefix}-${crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`}`; }
function formatPoint(point) { return point ? `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}` : uiText('not set'); }
function pointIcon(kind, index) {
  if (kind === 'origin' || kind === 'destination') {
    const label = kind === 'origin' ? '출발' : '도착';
    return L.divIcon({
      className: `virtual-point-icon virtual-endpoint-icon virtual-endpoint-${kind}`,
      html: `<svg class="virtual-endpoint-pin" viewBox="0 0 60 80" aria-hidden="true"><path d="M30 2C14.5 2 2 14.5 2 30c0 14 13 31 28 48 15-17 28-34 28-48C58 14.5 45.5 2 30 2Z"/><text x="30" y="34" text-anchor="middle">${label}</text></svg><button type="button" class="virtual-pin-remove" aria-label="${label} 위치 제거" title="제거">×</button>`,
      iconSize: [42, 56],
      iconAnchor: [21, 54.6],
    });
  }
  return L.divIcon({
    className: 'virtual-point-icon virtual-endpoint-icon virtual-waypoint-icon',
    html: `<svg class="virtual-endpoint-pin" viewBox="0 0 60 80" aria-hidden="true"><path d="M30 2C14.5 2 2 14.5 2 30c0 14 13 31 28 48 15-17 28-34 28-48C58 14.5 45.5 2 30 2Z"/><text x="30" y="35" text-anchor="middle">${index + 1}</text></svg><button type="button" class="virtual-pin-remove" aria-label="경유지 ${index + 1} 제거" title="제거">×</button>`,
    iconSize: [42, 56],
    iconAnchor: [21, 54.6],
  });
}
function cancelPointPlacement() {
  if (!pointPlacement) return;
  if (endpointDrag?.marker === movingPin) finishEndpointDrag(movingPin);
  movingPin?.remove();
  movingPin = null;
  if (pointPlacement.originalMarker) pointPlacement.originalMarker.setOpacity(1);
  pointPlacement = null;
  pickMode = null;
  map.getContainer().style.cursor = '';
}
function renderEndpointSnapPreview(context, snapped) {
  endpointSnapPreviewLayerGroup.eachLayer(layer => {
    if (layer !== context.snapCircle && layer !== context.snapRipple) endpointSnapPreviewLayerGroup.removeLayer(layer);
  });
  const color = context.kind === 'origin' ? '#16a34a' : context.kind === 'destination' ? '#dc2626' : '#f59e0b';
  const nearbyRoads = snapped.nearbyRoadGeometry?.type === 'MultiLineString'
    ? snapped.nearbyRoadGeometry.coordinates
    : snapped.roadGeometry?.type === 'LineString' ? [snapped.roadGeometry.coordinates] : [];
  const roads = (nearbyRoads || []).map(coordinates => coordinates
    .map(([lon, lat]) => [Number(lat), Number(lon)])
    .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon)))
    .filter(road => road.length > 1);
  if (roads.length) {
    L.polyline(roads, { renderer: endpointRoadOutlineRenderer, color, weight: 14, opacity: 1, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(endpointSnapPreviewLayerGroup);
  }
  if (context.snapCircle) {
    context.snapCircle.setLatLng([snapped.lat, snapped.lon]);
    context.snapRipple.setLatLng([snapped.lat, snapped.lon]);
  } else {
    context.snapRipple = L.circleMarker([snapped.lat, snapped.lon], {
      renderer: endpointSnapCircleRenderer, className: 'snap-circle-ripple',
      radius: 12, color: '#facc15', weight: 3, fill: false, interactive: false,
    }).addTo(endpointSnapPreviewLayerGroup);
    context.snapCircle = L.circleMarker([snapped.lat, snapped.lon], {
      renderer: endpointSnapCircleRenderer, className: 'snap-circle-pulse',
      radius: 12, color: '#facc15', weight: 4, fill: false, interactive: false,
    }).addTo(endpointSnapPreviewLayerGroup);
    animateSnapCircle(context);
  }
  if (context.kind === 'waypoint') {
    const waypoints = points.waypoints.slice();
    if (waypoints[context.index]) waypoints[context.index] = { lat: snapped.lat, lon: snapped.lon };
    document.querySelector('#virtual-waypoints').textContent = waypoints.map(formatPoint).join(' · ');
  } else {
    document.querySelector(`#virtual-${context.kind}`).textContent = formatPoint({ lat: snapped.lat, lon: snapped.lon });
  }
}
function animateSnapCircle(context) {
  const startedAt = performance.now();
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const tick = (now) => {
    if (endpointDrag !== context) return;
    const phase = ((now - startedAt) % 1200) / 1200;
    const pulse = (1 - Math.cos(phase * Math.PI * 2)) / 2;
    context.snapCircle.setRadius(reducedMotion ? 11 : 9 + 4 * pulse);
    context.snapCircle.setStyle({
      color: `rgb(255, ${Math.round(170 + 75 * pulse)}, ${Math.round(20 + 110 * pulse)})`,
      opacity: 0.65 + 0.35 * pulse,
      weight: 3 + 2 * pulse,
    });
    context.snapRipple.setRadius(12 + 17 * phase);
    context.snapRipple.setStyle({ opacity: reducedMotion ? 0 : 0.9 * (1 - phase) });
    context.animationFrame = requestAnimationFrame(tick);
  };
  context.animationFrame = requestAnimationFrame(tick);
}
function queueEndpointSnapPreview(context, marker) {
  context.latestPoint = marker.getLatLng();
  if (context.timer || context.inFlight) return;
  const delay = Math.max(0, 80 - (performance.now() - context.lastRequestAt));
  context.timer = setTimeout(() => {
    context.timer = null;
    if (endpointDrag !== context) return;
    context.lastRequestAt = performance.now();
    context.inFlight = true;
    const rawPoint = { lat: context.latestPoint.lat, lon: context.latestPoint.lng };
    const requestId = ++context.requestId;
    void api(`/api/v1/virtual/scenarios/${encodeURIComponent(scenarioId)}/route-points/snap`, {
      method: 'POST', body: JSON.stringify(rawPoint),
    }).then((snapped) => {
      if (endpointDrag !== context || requestId !== context.requestId) return;
      const point = { lat: Number(snapped.lat), lon: Number(snapped.lon) };
      if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return;
      renderEndpointSnapPreview(context, { ...snapped, ...point });
      if (!snapped.nearbyRoadGeometry && !snapped.roadGeometry) {
        setStatus('스냅 위치는 표시했지만 도로 윤곽 정보를 받지 못했습니다.', true);
      }
    }).catch((error) => {
      if (endpointDrag === context && requestId === context.requestId) {
        setStatus(`도로 스냅 미리보기를 표시할 수 없습니다: ${error.message}`, true);
      }
    }).finally(() => {
      context.inFlight = false;
      if (endpointDrag === context && (context.latestPoint.lat !== rawPoint.lat || context.latestPoint.lng !== rawPoint.lon)) {
        queueEndpointSnapPreview(context, marker);
      }
    });
  }, delay);
}
function startEndpointDrag(kind, marker, index = null) {
  endpointDrag = { kind, marker, index, requestId: 0, lastRequestAt: 0, timer: null };
  marker.setOpacity(0.65);
  endpointSnapPreviewLayerGroup.clearLayers();
  const position = marker.getLatLng();
  renderEndpointSnapPreview(endpointDrag, { lat: position.lat, lon: position.lng });
  queueEndpointSnapPreview(endpointDrag, marker);
}
function finishEndpointDrag(marker) {
  if (endpointDrag?.timer) clearTimeout(endpointDrag.timer);
  if (endpointDrag?.animationFrame !== undefined) cancelAnimationFrame(endpointDrag.animationFrame);
  endpointDrag = null;
  endpointSnapPreviewLayerGroup.clearLayers();
  marker.setOpacity(1);
}
function markPointsChanged(message) {
  draft = null;
  renderDraft();
  setStatus(message);
}
function removeRoutePoint(kind, index) {
  cancelInFlightRouteCalculation();
  if (kind === 'waypoint') points.waypoints.splice(index, 1);
  else points[kind] = null;
  renderPoints();
  const label = kind === 'waypoint' ? `경유지 ${index + 1}` : kind === 'origin' ? '출발지' : '도착지';
  void refreshPreviewAfterPointChange(`${label} 핀을 제거했습니다.`);
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
  cancelInFlightRouteCalculation();
  const controller = new AbortController();
  routeCalculationController = controller;
  const finishRouting = beginRouteCalculation('목적지까지 경로를 다시 계산하는 중…');
  try {
    setStatus('Recalculating from the vehicle position to the new destination…');
    await api(`/api/v1/virtual/trips/${encodeURIComponent(activeTrip.tripId)}/destination`, {
      method: 'PUT',
      body: JSON.stringify({ destination, expectedTripRevision }),
      signal: controller.signal,
    });
    if (routeCalculationController !== controller) return;
    await loadScenarioData();
    if (routeCalculationController !== controller) return;
    setStatus('Destination updated and optimal path recalculated.');
  } catch (error) {
    if (controller.signal.aborted || routeCalculationController !== controller) return;
    if (previousDestination) {
      points.destination = previousDestination;
      renderPoints();
    }
    setStatus(error.message, true);
  } finally {
    if (routeCalculationController === controller) routeCalculationController = null;
    finishRouting();
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
  if (kind === 'waypoint') marker.bindTooltip(`Waypoint ${index + 1}`);
  marker.on('click', event => {
    if (event.originalEvent) L.DomEvent.stop(event.originalEvent);
    beginRoutePointPick(kind, kind === 'waypoint' ? index : null, marker.getLatLng(), marker);
  });
  marker.on('dragstart', () => {
    marker.getElement()?.classList.add('is-dragging');
    startEndpointDrag(kind, marker, kind === 'waypoint' ? index : null);
  });
  marker.on('drag', () => {
    if (endpointDrag?.marker === marker) queueEndpointSnapPreview(endpointDrag, marker);
  });
  marker.on('dragend', () => {
    marker.getElement()?.classList.remove('is-dragging');
    const position = marker.getLatLng();
    finishEndpointDrag(marker);
    void snapAndSetRoutePoint(kind, { lat: position.lat, lon: position.lng }, index);
  });
  marker.on('add', () => {
    const removeButton = marker.getElement()?.querySelector('.virtual-pin-remove');
    if (!removeButton) return;
    removeButton.addEventListener('mousedown', event => { event.preventDefault(); event.stopPropagation(); });
    removeButton.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      if (endpointDrag?.marker === marker) finishEndpointDrag(marker);
      removeRoutePoint(kind, index);
    });
  });
  pointLayerGroup.addLayer(marker);
}
function renderPoints() {
  if (endpointDrag) return;
  pointLayerGroup.clearLayers();
  drawPoint('origin', points.origin);
  drawPoint('destination', points.destination);
  points.waypoints.forEach((point, index) => drawPoint('waypoint', point, index));
  document.querySelector('#virtual-origin').textContent = formatPoint(points.origin);
  document.querySelector('#virtual-destination').textContent = formatPoint(points.destination);
  document.querySelector('#virtual-waypoints').textContent = points.waypoints.length ? points.waypoints.map(formatPoint).join(' · ') : uiText('none');
}
function restrictionLabel(restriction) {
  const kind = restriction?.kind === 'HEAVY_PENALTY' ? '혼잡 구간' : '도로 차단';
  const factor = restriction?.kind === 'HEAVY_PENALTY' && restriction?.penaltyFactor !== null && restriction?.penaltyFactor !== undefined
    ? ` · ×${Number(restriction.penaltyFactor).toFixed(1)}` : '';
  return `${kind}${factor} · revision ${restriction?.revision ?? '?'}`;
}
function restrictionMapLabel(restriction) {
  return restriction?.kind === 'BLOCKED' ? String(restriction?.revision ?? '') : restrictionLabel(restriction);
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
    const color = restriction.kind === 'HEAVY_PENALTY' ? '#f59a23' : '#ed3d4f';
    if (restriction.geometry) {
      const layer = L.geoJSON(restriction.geometry, {
        style: { color, weight: 2, fillColor: color, fillOpacity: 0.16 },
      });
      layer.bindTooltip(restrictionMapLabel(restriction), {permanent:true,direction:'center',className:'road-region-label'});
      layer.on('add', () => requestAnimationFrame(() => applyRoadHatch(layer, restriction.kind, color)));
      restrictionLayerGroup.addLayer(layer);
    }
    const row = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = restrictionLabel(restriction);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.disabled = routeOperations.size > 0;
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
function updateRouteSummary(route, waypointCount = points.waypoints.length) {
  const distance=route?.distanceM ?? route?.route?.distanceM;
  const duration=route?.durationSec ?? route?.route?.durationSec;
  document.querySelector('#route-summary-values').textContent=route
    ? `총 거리  ${distance==null?'—':(Number(distance)/1000).toFixed(2)+' km'}\n예상 시간  ${duration==null?'—':(Number(duration)/60).toFixed(1)+'분'}\n경유지  ${waypointCount}개`
    : '경로를 미리 보거나 차량을 선택하세요.';
  document.querySelector('#route-summary-revision').textContent=route?`경로 v${route.routeVersion??'미리보기'} · 도로 상태 v${route.restrictionRevision??scenarioRevision}`:'';
}
function renderDraft() {
  updateRouteSummary(draft);
  if (!draft) {
    if (draftRouteSignature) clearRouteGroup(routeLayerGroup);
    draftRouteSignature = '';
    document.querySelector('#virtual-draft-summary').textContent = '경로 미리보기를 실행하세요.';
    document.querySelector('#virtual-dispatch').disabled = true;
    return;
  }
  const signature = String(draft.draftId ?? JSON.stringify(draft.routeGeojson ?? draft.route ?? ''));
  if (signature === draftRouteSignature) return;
  draftRouteSignature = signature;
  clearRouteGroup(routeLayerGroup);
  addRouteVisual(routeLayerGroup, draft.routeGeojson, {
    outlineColor: '#ffffff', outlineWeight: 14, outlineOpacity: 0.78,
    lineColor: '#62a9f8', lineWeight: 11, lineOpacity: 0.98, arrowColor: '#ffffff', arrowYawn: 36, showArrows: true,
  }, 'Route preview');
  document.querySelector('#virtual-draft-summary').textContent = `Draft ${draft.draftId} · ${(Number(draft.distanceM || draft.route?.distanceM || 0) / 1000).toFixed(2)} km · ${(Number(draft.durationSec || draft.route?.durationSec || 0) / 60).toFixed(1)} min · restriction revision ${draft.restrictionRevision}`;
  document.querySelector('#virtual-dispatch').disabled = dispatchSubmitting;
}
function renderActiveTripRoute(vehicle) {
  const trip = vehicle?.state?.trip;
  const routes = Array.isArray(trip?.routes) ? trip.routes.filter((route) => route?.routeGeojson) : [];
  if (!routes.length) {
    updateRouteSummary(draft);
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
  updateRouteSummary(draft || currentRoute, draft ? (draft.waypoints?.length ?? points.waypoints.length) : (trip.waypoints?.length ?? 0));
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
      ? { outlineColor: '#ffffff', outlineWeight: 14, outlineOpacity: 0.82, lineColor: '#0875f5', lineWeight: 11, lineOpacity: 1, arrowColor: '#ffffff', arrowOpacity: 0.98, arrowYawn: 36, showArrows: true }
      : { outlineColor: '#59452b', outlineWeight: 12, outlineOpacity: 0.62, lineColor: '#f59e0b', lineWeight: 9, lineOpacity: 0.72, arrowColor: '#ffffff', arrowOpacity: 0.62, arrowYawn: 36, showArrows: !duplicateGeometry && Boolean(previousArrowGeometry), arrowGeometry: previousArrowGeometry },
    current ? `Active route · v${route.routeVersion}` : `Previous route · v${route.routeVersion}`);
  }
}
map.on?.('zoomend', () => {
  for (const visual of routeVisuals) applyRouteStrokeWidths(visual);
});
function renderVehicles({ updateVehicleSelect = true } = {}) {
  const selected = selectedVehicleId;
  if (updateVehicleSelect) {
    vehicleSelect.replaceChildren(new Option('가상 차량 선택', ''));
    for (const vehicle of vehicles) {
      const state = vehicle.state?.simStatus || vehicle.vehicleStatus || 'READY';
      vehicleSelect.add(new Option(`${vehicle.vehicleCode}${vehicle.vehicleName ? ` · ${vehicle.vehicleName}` : ''} · ${state}`, String(vehicle.vehicleId)));
    }
    if (vehicles.some((vehicle) => String(vehicle.vehicleId) === selected)) vehicleSelect.value = selected;
    else selectedVehicleId = '';
  } else if (!vehicles.some((vehicle) => String(vehicle.vehicleId) === selected)) {
    selectedVehicleId = '';
  }
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
      marker = L.marker([Number(position.lat), Number(position.lon)], { icon: vehicleIcon(vehicle, vehicleId === selected, true) });
      marker.bindTooltip(`Virtual · ${vehicle.vehicleCode}`);
      marker.on('click', () => { selectedVehicleId = vehicleId; vehicleSelect.value = selectedVehicleId; speedControlEditing = false; renderSelectedVehicle(vehicles.find((item) => String(item.vehicleId) === vehicleId)); });
      virtualVehicleMarkers.set(vehicleId, marker);
      markerLayerGroup.addLayer(marker);
    } else {
      animateVehicleMarker(vehicleId, marker, { lat: Number(position.lat), lon: Number(position.lon) });
      marker.setIcon(vehicleIcon(vehicle, vehicleId === selected, true));
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
  if (!trip) { speedControlEditing = false; renderSpeedControl(vehicle?.state?.speedKmh); return; }
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
  document.querySelector('#request-count').textContent=`(${requests.filter(request=>request.state==='PENDING').length})`;
  requestList.replaceChildren();
  if (!requests.length) { requestList.append(Object.assign(document.createElement('li'), { textContent: uiText('No pending requests.') })); return; }
  for (const request of requests) {
    const row = document.createElement('li');
    row.textContent = `Request ${request.requestId} · vehicle ${request.selectedVehicleId} · ${request.state}${request.acceptAt ? ` · ${new Date(request.acceptAt).toLocaleTimeString()}` : ''}`;
    if (request.state === 'PENDING') {
      const accept = document.createElement('button'); accept.type = 'button'; accept.textContent = uiText('Accept'); accept.onclick = () => decideRequest(request.requestId, 'accept');
      const reject = document.createElement('button'); reject.type = 'button'; reject.textContent = uiText('Reject'); reject.onclick = () => decideRequest(request.requestId, 'reject');
      row.append(' ', accept, ' ', reject);
    }
    requestList.append(row);
  }
}
function renderEvents(events) {
  if (!events.length) return;
  if (hasLoadedEvents) {
    for (const event of events) {
      if (event.eventType === 'VEHICLE_BLOCKED_BY_RESTRICTION') {
        showRoutingLog('차량이 차단된 도로에 도달해 정지했습니다.', null, event.payload || {});
      }
    }
  }
  eventList.replaceChildren(...events.slice(-30).map((event) => {
    const li = document.createElement('li'); li.textContent = `${new Date(event.createdAt).toLocaleTimeString()} · ${event.eventType}`; return li;
  }));
  const last = events.at(-1); if (last) lastEventId = String(last.eventId);
  hasLoadedEvents = true;
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
  if (!scenarioId) setStatus(uiText('Create a scenario to begin.'));
}
async function loadScenarioData() {
  if (!scenarioId) {
    vehicles = [];
    selectedVehicleId = '';
    renderRestrictions([]);
    renderVehicles();
    renderRequests([]);
    eventList.replaceChildren();
    eventScenarioId = '';
    lastEventId = '';
    hasLoadedEvents = false;
    return;
  }
  if (eventScenarioId !== scenarioId) {
    eventScenarioId = scenarioId;
    lastEventId = '';
    hasLoadedEvents = false;
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
  syncNoRouteAlarms();
  renderVehicles();
  renderRequests(requests);
  renderEvents(events);
  hasLoadedEvents = true;
}
async function refreshVehiclePositions() {
  if (!scenarioId || mode !== 'virtual') return;
  const requestedScenarioId = scenarioId;
  const latestVehicles = await api(`/api/v1/virtual/scenarios/${requestedScenarioId}/vehicles`);
  if (mode !== 'virtual' || scenarioId !== requestedScenarioId) return;
  vehicles = latestVehicles;
  syncNoRouteAlarms();
  renderVehicles({ updateVehicleSelect: false });
}
async function decideRequest(requestId, action) {
  try { await api(`/api/v1/virtual/dispatch-requests/${requestId}/${action}`, { method: 'POST', body: '{}' }); await loadScenarioData(); setStatus(`Request ${requestId} ${action}ed.`); }
  catch (error) { setStatus(error.message, true); }
}
async function previewRoute() {
  if (!scenarioId || !selectedVehicleId || !points.origin || !points.destination) { setStatus(uiText('Select a virtual vehicle and pick origin and destination.'), true); return; }
  cancelInFlightRouteCalculation();
  const controller = new AbortController();
  routeCalculationController = controller;
  const finishRouting = beginRouteCalculation('경로를 계산하는 중…');
  try {
    const nextDraft = await api(`/api/v1/virtual/scenarios/${scenarioId}/routes/preview`, { method: 'POST', body: JSON.stringify({ selectedVehicleId, origin: points.origin, destination: points.destination, waypoints: points.waypoints, expectedRestrictionRevision: scenarioRevision }), signal: controller.signal });
    if (routeCalculationController !== controller) return;
    draft = nextDraft;
    renderDraft(); setStatus(`Route preview ready for vehicle ${selectedVehicleId}.`);
  } catch (error) {
    if (controller.signal.aborted || routeCalculationController !== controller) return;
    draft = null; renderDraft(); showRoutingLog(error.message, error.details); setStatus(error.message, true);
  } finally {
    if (routeCalculationController === controller) routeCalculationController = null;
    finishRouting();
  }
}
async function generateRequest() {
  if (!draft || dispatchSubmitting) return;
  dispatchSubmitting = true;
  renderDraft();
  let request;
  try {
    request = await api(`/api/v1/virtual/scenarios/${scenarioId}/dispatch-requests`, {
      method: 'POST', body: JSON.stringify({ draftId: String(draft.draftId), selectedVehicleId, idempotencyKey: idempotency('dispatch') }),
    });
    // Once created, use the request's identity for acceptance; never create a
    // second request from the same draft if acceptance needs to be retried.
    draft = null;
    if (request.state !== 'ACCEPTED') {
      await api(`/api/v1/virtual/dispatch-requests/${encodeURIComponent(request.requestId)}/accept`, { method: 'POST', body: '{}' });
    }
    setStatus('배차 요청이 즉시 수락되었습니다. 차량이 출발합니다.');
  } catch (error) {
    setStatus(request ? `배차 요청 ${request.requestId}의 자동 수락에 실패했습니다: ${error.message}` : error.message, true);
  } finally {
    dispatchSubmitting = false;
    renderDraft();
  }
  try { await loadScenarioData(); }
  catch (error) { setStatus(error.message, true); }
}
async function createScenario() {
  try { const scenario = await api('/api/v1/virtual/scenarios', { method: 'POST', body: JSON.stringify({ name: `Scenario ${new Date().toLocaleString()}`, autoAcceptAfterSeconds: 30 }) }); scenarioId = String(scenario.scenarioId); await loadScenarios(); await loadScenarioData(); setStatus(uiText('Scenario created.')); }
  catch (error) { setStatus(error.message, true); }
}
async function removeScenario() {
  if (!scenarioId) { setStatus(uiText('Select a scenario first.'), true); return; }
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
    roadBrush.reset();
    cancelPointPlacement();
    map.getContainer().style.cursor = '';
    restrictionLayerGroup.clearLayers();
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
  try { const vehicle = await api(`/api/v1/virtual/scenarios/${scenarioId}/vehicles`, { method: 'POST', body: JSON.stringify({ vehicleCode: `SIM-${Date.now()}`, vehicleName: uiText('Virtual vehicle'), vehicleProfile: 'small', autoFollowEnabled: true }) }); selectedVehicleId = String(vehicle.vehicleId); await loadScenarioData(); setStatus('Virtual vehicle added.'); if (points.origin && points.destination) await refreshPreviewAfterPointChange('Vehicle added.'); }
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
  try {
    const result = await api(`/api/v1/virtual/vehicles/${selectedVehicleId}/following`, { method: 'PUT', body: JSON.stringify({ enabled, expectedPolicyVersion: vehicle?.following?.policyVersion, idempotencyKey: idempotency('follow') }) });
    await loadScenarioData();
    if (result.state?.simStatus === 'NO_ROUTE') showRoutingLog(result.state.blockedReason || '경로 추종 중 경로 계산에 실패했습니다.', null, { vehicleId: selectedVehicleId, tripId: result.state.virtualTripId });
  }
  catch (error) { showRoutingLog(error.message, error.details, { vehicleId: selectedVehicleId }); setStatus(error.message, true); }
}
async function command(command, extra = {}) {
  const vehicle = vehicles.find((item) => String(item.vehicleId) === selectedVehicleId);
  const tripId = vehicle?.state?.virtualTripId || vehicle?.state?.trip?.virtualTripId;
  if (!tripId) { setStatus('The selected virtual vehicle has no active trip.', true); return; }
  try {
    await api(`/api/v1/virtual/trips/${tripId}/commands`, { method: 'POST', body: JSON.stringify({ command, ...extra }) });
    if (command === 'SET_SPEED_KMH') speedControlEditing = false;
    await loadScenarioData();
  }
  catch (error) { setStatus(error.message, true); }
}
async function applySelectedSpeed() {
  const activeTrip = selectedActiveTrip();
  if (!activeTrip) {
    setStatus('The selected virtual vehicle has no active trip.', true);
    return;
  }
  speedControlEditing = true;
  renderSpeedControl();
  pendingSpeedChange = {
    tripId: activeTrip.tripId, vehicleId: selectedVehicleId,
    scenarioId, speedKmh: selectedSpeedKmh(),
  };
  if (applyingSpeedChange) return;
  applyingSpeedChange = true;
  let lastChange;
  try {
    // Serialize commands so rapid slider changes cannot arrive out of order.
    // While a command is in flight, retain only the latest selected speed.
    while (pendingSpeedChange) {
      const change = pendingSpeedChange;
      pendingSpeedChange = null;
      lastChange = change;
      try {
        await api(`/api/v1/virtual/trips/${change.tripId}/commands`, {
          method: 'POST', body: JSON.stringify({ command: 'SET_SPEED_KMH', speedKmh: change.speedKmh }),
        });
      } catch (error) {
        if (selectedVehicleId === change.vehicleId) setStatus(error.message, true);
      }
    }
  } finally {
    applyingSpeedChange = false;
    if (lastChange?.vehicleId === selectedVehicleId) speedControlEditing = false;
  }
  if (lastChange?.scenarioId === scenarioId) {
    try { await loadScenarioData(); }
    catch (error) { setStatus(error.message, true); }
  }
}
function beginRoutePointPick(kind, waypointIndex = null, initialPoint = map.getCenter(), originalMarker = null) {
  roadBrush.reset();
  if (!scenarioId) { setStatus('Select or create a scenario first.', true); return; }
  cancelPointPlacement();
  pickMode = kind;
  pointPlacement = { kind, waypointIndex, originalMarker };
  if (originalMarker) originalMarker.setOpacity(0);
  movingPin = L.marker(initialPoint, { icon: pointIcon(kind, waypointIndex ?? points.waypoints.length), interactive: false, keyboard: false, opacity: 0.85, zIndexOffset: 10000 }).addTo(map);
  movingPin.getElement()?.classList.add('is-moving');
  startEndpointDrag(kind, movingPin, waypointIndex);
  const label = kind === 'waypoint' ? `경유지 ${waypointIndex === null ? points.waypoints.length + 1 : waypointIndex + 1}` : kind === 'origin' ? '출발지' : '도착지';
  map.getContainer().style.cursor = 'crosshair';
  setStatus(`${label} 핀이 이동 중입니다. 지도에서 한 번 더 클릭해 놓으세요.`);
}
window.__operatorPointPlacementActive = () => Boolean(pointPlacement);
map.on('mousemove', event => {
  if (!pointPlacement || !movingPin) return;
  movingPin.setLatLng(event.latlng);
  if (endpointDrag?.marker === movingPin) queueEndpointSnapPreview(endpointDrag, movingPin);
});
async function snapAndSetRoutePoint(kind, rawPoint, waypointIndex = null) {
  const previousDestination = kind === 'destination' ? points.destination : null;
  const previousPoint = kind === 'waypoint' ? points.waypoints[waypointIndex] : points[kind];
  const label = kind === 'waypoint' ? `Waypoint ${waypointIndex === null ? points.waypoints.length + 1 : waypointIndex + 1}` : kind[0].toUpperCase() + kind.slice(1);
  const finishRouting = beginRouteCalculation('위치를 도로에 맞추고 경로를 계산하는 중…');
  setStatus(`Snapping ${label.toLowerCase()} to the nearest road…`);
  try {
    const snapped = await api(`/api/v1/virtual/scenarios/${encodeURIComponent(scenarioId)}/route-points/snap`, {
      method: 'POST', body: JSON.stringify(rawPoint),
    });
    const point = { lat: Number(snapped.lat), lon: Number(snapped.lon) };
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) throw new Error('Routing returned an invalid snapped point.');
    if (previousPoint && map.distance([previousPoint.lat, previousPoint.lon], [point.lat, point.lon]) < 1) {
      renderPoints();
      setStatus(`${label} stayed at the same snapped location.`);
      return;
    }
    cancelInFlightRouteCalculation();
    if (kind === 'origin') points.origin = point;
    else if (kind === 'destination') points.destination = point;
    else if (waypointIndex === null) points.waypoints.push(point);
    else if (points.waypoints[waypointIndex]) points.waypoints[waypointIndex] = point;
    renderPoints();
    const message = kind === 'waypoint' && waypointIndex === null
      ? `${label} added and snapped to road.`
      : `${label} snapped to road.`;
    await refreshPreviewAfterPointChange(message, kind, previousDestination);
  } catch (error) {
    renderPoints();
    setStatus(`Could not snap ${label.toLowerCase()}: ${error.message}`, true);
  } finally {
    finishRouting();
  }
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
async function removeRestriction(restriction) {
  if (!scenarioId || !restriction?.restrictionId || routeOperations.size > 0) return;
  const label = restrictionLabel(restriction);
  if (!window.confirm(`Remove ${label}? Routes will be recalculated.`)) return;
  const finishRouting = beginRouteCalculation('차단 구간을 해제하고 경로를 다시 계산하는 중…');
  try {
    setStatus(`Removing ${label} and recalculating affected virtual routes…`);
    await api(`/api/v1/virtual/road-restrictions/${encodeURIComponent(restriction.restrictionId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive: false, expectedRestrictionRevision: scenarioRevision }),
    });
    await refreshAfterRestrictionChange('도로 구간을 해제했습니다.');
  } catch (error) { setStatus(error.message, true); }
  finally { finishRouting(); }
}
// Whether Live View was open when virtual mode closed it, so it can reopen.
let liveViewBeforeVirtual = false;
async function switchMode(next) {
  cancelInFlightRouteCalculation();
  roadBrush.reset();
  cancelPointPlacement();
  hideRouteContextMenu();
  if (endpointDrag) finishEndpointDrag(endpointDrag.marker);
  pickMode = null;
  map.getContainer().style.cursor = '';
  mode = next; window.__virtualMode = next === 'virtual';
  document.body.classList.toggle('virtual-mode', next === 'virtual');
  virtualPanel.hidden = next !== 'virtual';
  normalTab.setAttribute('aria-pressed', String(next === 'normal')); virtualTab.setAttribute('aria-pressed', String(next === 'virtual'));
  if (next === 'virtual') {
    // Close Live View rather than hiding its panel: the open state also carries
    // the live-view-open layout class, which sets #operator-sidebar to
    // display:none. Left behind, it keeps the whole sidebar invisible after the
    // switch back, however the individual sections are set.
    if (!liveViewBeforeVirtual) liveViewBeforeVirtual = Boolean(window.__operatorLiveViewOpen?.());
    window.__operatorStopLiveView?.();
    window.__operatorCancelMapPick?.();
    normalSectionVisibility.hide();
    // Ask the normal workspace to take its own layers off the map. Sweeping
    // them off from here removed markers this module cannot put back: they are
    // cached by external_id and only ever added to the map on creation, so the
    // fleet never reappeared after switching back.
    window.__operatorDetachMapLayers?.();
    try { await loadScenarios(); await loadScenarioData(); setStatus('가상 경로·배차 준비 완료'); } catch (error) { setStatus(error.message, true); }
    if (!pollTimer) pollTimer = setInterval(() => void loadScenarioData().catch((error) => setStatus(error.message, true)), 1000);
    if (!vehiclePollTimer) vehiclePollTimer = setInterval(() => void refreshVehiclePositions().catch((error) => setStatus(error.message, true)), 250);
  } else {
    noRouteAlarm.hidden = true;
    seenNoRouteKeys.clear();
    normalSectionVisibility.restore();
    window.__operatorAttachMapLayers?.();
    if (liveViewBeforeVirtual) { liveViewBeforeVirtual = false; window.__operatorResumeLiveView?.(); }
    clearRouteGroup(routeLayerGroup); clearRouteGroup(activeRouteLayerGroup); clearVirtualVehicleMarkers(); pointLayerGroup.clearLayers(); restrictionLayerGroup.clearLayers();
    draftRouteSignature = '';
    activeRouteSignature = '';
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (vehiclePollTimer) { clearInterval(vehiclePollTimer); vehiclePollTimer = null; }
    window.__virtualMode = false;
  }
  setTimeout(() => map.invalidateSize({ pan: false }), 0);
}
map.on('click', (event) => {
  hideRouteContextMenu();
  if (mode !== 'virtual' || !pickMode) return;
  const point = { lat: event.latlng.lat, lon: event.latlng.lng };
  const selectedMode = pickMode;
  const selectedIndex = pointPlacement?.waypointIndex ?? null;
  const pin = movingPin;
  const originalMarker = pointPlacement?.originalMarker;
  if (pin && endpointDrag?.marker === pin) finishEndpointDrag(pin);
  pin?.remove();
  if (originalMarker) originalMarker.setOpacity(1);
  movingPin = null;
  pointPlacement = null;
  pickMode = null;
  map.getContainer().style.cursor = '';
  void snapAndSetRoutePoint(selectedMode, point, selectedIndex);
});
normalTab.addEventListener('click', () => void switchMode('normal'));
virtualTab.addEventListener('click', () => void switchMode('virtual'));
scenarioSelect.addEventListener('change', () => { cancelInFlightRouteCalculation(); roadBrush.reset(); cancelPointPlacement(); scenarioId = scenarioSelect.value; speedControlEditing = false; draft = null; renderDraft(); void loadScenarios().then(loadScenarioData); });
vehicleSelect.addEventListener('change', () => {
  selectedVehicleId = vehicleSelect.value;
  speedControlEditing = false;
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
document.querySelector('#virtual-speed').addEventListener('input', () => void applySelectedSpeed());
document.querySelector('#virtual-add-waypoint').addEventListener('click', () => beginRoutePointPick('waypoint'));
map.getContainer().addEventListener('operator-map-contextrequest', (event) => showRouteContextMenu(event.detail));
routeContextMenu.addEventListener('click', (event) => {
  event.stopPropagation();
  if (routeOperations.size > 0) return;
  const toolButton = event.target.closest('[data-road-tool]');
  if (toolButton) {
    hideRouteContextMenu();
    if (!scenarioId) { setStatus('시나리오를 먼저 선택하세요.', true); return; }
    cancelPointPlacement();
    roadBrush.setTool(toolButton.dataset.roadTool);
    return;
  }
  const button = event.target.closest('[data-route-point-kind]');
  if (!button || !contextRoutePoint) return;
  const kind = button.dataset.routePointKind;
  const point = { lat: contextRoutePoint.lat, lng: contextRoutePoint.lng };
  hideRouteContextMenu();
  if (!scenarioId) { setStatus('Select or create a scenario first.', true); return; }
  roadBrush.reset();
  beginRoutePointPick(kind, null, point);
});
document.addEventListener('pointerdown', (event) => {
  if (!routeContextMenu.hidden && !routeContextMenu.contains(event.target)) hideRouteContextMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && pointPlacement) { cancelPointPlacement(); setStatus('핀 이동을 취소했습니다.'); return; }
  if (event.key === 'Escape' && !routeContextMenu.hidden) hideRouteContextMenu();
});
