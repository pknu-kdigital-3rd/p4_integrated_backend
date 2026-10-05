// Mouse painting uses left-drag; the shared map keeps right-drag panning.
export function installRoadBrush(map, { isActive, onStroke, onStatus, onTouchLongPress, onToolChange }) {
  const container = map.getContainer();
  const preview = L.layerGroup().addTo(map);
  let tool = null, stroke = null, cursor = null, line = null, busy = false, touchPointerId = null, pendingTouch = null;
  let previousMapDragging = null, previousTouchZoom = null;

  function clearPreview() { preview.clearLayers(); cursor = null; line = null; }
  function cancel() { stroke = null; clearPreview(); }
  function setMapGestureHandling(disabled) {
    if (disabled) {
      if (previousMapDragging !== null) return;
      previousMapDragging = map.dragging.enabled();
      previousTouchZoom = map.touchZoom.enabled();
      map.dragging.disable();
      map.touchZoom.disable();
      return;
    }
    if (previousMapDragging === null) return;
    if (previousMapDragging) map.dragging.enable(); else map.dragging.disable();
    if (previousTouchZoom) map.touchZoom.enable(); else map.touchZoom.disable();
    previousMapDragging = null;
    previousTouchZoom = null;
  }
  function setTool(next) {
    if (pendingTouch) window.clearTimeout(pendingTouch.timer);
    pendingTouch = null;
    touchPointerId = null;
    cancel(); tool = next;
    onToolChange?.(tool);
    setMapGestureHandling(Boolean(next) && next !== 'pan');
    container.style.cursor = next === 'pan' ? 'grab' : next ? 'crosshair' : '';
    onStatus(next === 'pan' ? '지도 이동 · 한 손가락으로 이동하고 두 손가락으로 확대·축소하세요. 그리기 또는 지우기를 선택해 작업을 계속하세요.'
      : next ? `${next === 'paint' ? '차단 브러시' : '차단 지우개'} · 마우스 왼쪽 버튼 또는 터치로 드래그하세요. 터치 길게 누르기로 메뉴를 엽니다.` : '차단 도구를 종료했습니다.');
  }
  function position(event) { return map.mouseEventToLatLng(event); }
  function radiusAt(point) {
    const pixel = map.latLngToContainerPoint(point);
    return Math.max(5, Math.min(250, map.distance(point, map.containerPointToLatLng([pixel.x + 18, pixel.y]))));
  }
  function showCursor(point, radius) {
    if (!cursor) cursor = L.circle(point, { radius, color: tool === 'paint' ? '#ed3d4f' : '#0878f9', weight: 2, fillOpacity: 0.12, interactive: false }).addTo(preview);
    cursor.setLatLng(point); cursor.setRadius(radius);
  }
  function appendStrokePoint(event) {
    if (!isActive() || !tool || tool === 'pan' || busy) return;
    if (event.pointerType !== 'touch' && (event.buttons & 2)) {
      if (!stroke) clearPreview();
      return;
    }
    if (event.target?.closest?.('.road-brush-toolbar,.virtual-route-context-menu,.leaflet-control')) {
      if (!stroke) clearPreview();
      return;
    }
    const bounds = container.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
      if (!stroke) clearPreview();
      return;
    }
    const point = position(event);
    showCursor(point, stroke?.radiusM ?? radiusAt(point));
    if (!stroke) return;
    if (event.pointerType !== 'touch' && !(event.buttons & 1)) { void finish(); return; }
    const last = stroke.points.at(-1);
    if (map.distance([last.lat, last.lon], point) < stroke.radiusM / 4) return;
    stroke.points.push({ lat: point.lat, lon: point.lng });
    line.addLatLng(point);
    if (stroke.points.length >= 256) void finish();
  }
  function startStroke(event) {
    if (!isActive() || !tool || tool === 'pan') return false;
    if (busy) return true;
    const point = position(event), radiusM = radiusAt(point);
    clearPreview(); showCursor(point, radiusM);
    stroke = { mode: tool, radiusM, points: [{ lat: point.lat, lon: point.lng }] };
    const pixel = map.latLngToContainerPoint(point);
    const metresPerPixel = map.distance(point, map.containerPointToLatLng([pixel.x + 1, pixel.y]));
    line = L.polyline([point], { color: tool === 'paint' ? '#ed3d4f' : '#0878f9', weight: 2 * radiusM / metresPerPixel, opacity: 0.35, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(preview);
    return true;
  }
  async function finish() {
    if (!stroke) return;
    const completed = stroke; stroke = null; busy = true;
    try { await onStroke(completed); }
    catch (error) { onStatus(error.message, true); }
    finally { busy = false; clearPreview(); }
  }
  function handleMouseDown(event) {
    if (event.button !== 0 || !isActive() || !tool || tool === 'pan') return false;
    return startStroke(event);
  }
  function handleTouchPointerDown(event) {
    if (event.pointerType !== 'touch' || !isActive() || !tool || tool === 'pan') return false;
    if (touchPointerId !== null && touchPointerId !== event.pointerId) return true;
    touchPointerId = event.pointerId;
    pendingTouch = { pointerId: event.pointerId, event, x: event.clientX, y: event.clientY, timer: 0 };
    pendingTouch.timer = window.setTimeout(() => {
      if (pendingTouch?.pointerId !== event.pointerId) return;
      pendingTouch = null;
      touchPointerId = null;
      onTouchLongPress?.({ clientX: event.clientX, clientY: event.clientY, touch: true });
    }, 550);
    return true;
  }
  document.addEventListener('pointermove', event => {
    if (event.pointerType !== 'touch' || event.pointerId !== touchPointerId) return;
    if (pendingTouch) {
      if (Math.hypot(event.clientX - pendingTouch.x, event.clientY - pendingTouch.y) <= 10) return;
      window.clearTimeout(pendingTouch.timer);
      const initialEvent = pendingTouch.event;
      pendingTouch = null;
      startStroke(initialEvent);
    }
    appendStrokePoint(event);
  });
  document.addEventListener('pointerup', event => {
    if (event.pointerType !== 'touch' || event.pointerId !== touchPointerId) return;
    if (pendingTouch) {
      window.clearTimeout(pendingTouch.timer);
      const initialEvent = pendingTouch.event;
      pendingTouch = null;
      startStroke(initialEvent);
    }
    touchPointerId = null;
    void finish();
  });
  document.addEventListener('pointercancel', event => {
    if (event.pointerType !== 'touch' || event.pointerId !== touchPointerId) return;
    if (pendingTouch) window.clearTimeout(pendingTouch.timer);
    pendingTouch = null;
    touchPointerId = null;
    void finish();
  });
  document.addEventListener('mousemove', event => {
    appendStrokePoint(event);
  });
  document.addEventListener('mouseup', event => { if (event.button === 0) void finish(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && tool) setTool(null); });
  window.addEventListener('blur', () => { if (stroke) void finish(); else clearPreview(); });
  map.on('zoomstart', () => { if (stroke) void finish(); else clearPreview(); });
  return { setTool, handleMouseDown, handleTouchPointerDown, reset() { cancel(); tool = null; onToolChange?.(null); touchPointerId = null; if (pendingTouch) window.clearTimeout(pendingTouch.timer); pendingTouch = null; setMapGestureHandling(false); container.style.cursor = ''; } };
}
