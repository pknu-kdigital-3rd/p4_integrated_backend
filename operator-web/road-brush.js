// Mouse painting uses left-drag; the shared map keeps right-drag panning.
export function installRoadBrush(map, { isActive, onStroke, onStatus }) {
  const container = map.getContainer();
  const preview = L.layerGroup().addTo(map);
  let tool = null, stroke = null, cursor = null, line = null, busy = false;

  function clearPreview() { preview.clearLayers(); cursor = null; line = null; }
  function cancel() { stroke = null; clearPreview(); }
  function setTool(next) {
    cancel(); tool = next;
    container.style.cursor = next ? 'crosshair' : '';
    onStatus(next ? `${next === 'paint' ? '차단 브러시' : '차단 지우개'} · 왼쪽 버튼을 누르고 드래그하세요. Esc로 종료합니다.` : '차단 도구를 종료했습니다.');
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
  async function finish() {
    if (!stroke) return;
    const completed = stroke; stroke = null; busy = true;
    try { await onStroke(completed); }
    catch (error) { onStatus(error.message, true); }
    finally { busy = false; clearPreview(); }
  }
  function handleMouseDown(event) {
    if (event.button !== 0 || !isActive() || !tool) return false;
    if (busy) return true;
    const point = position(event), radiusM = radiusAt(point);
    clearPreview(); showCursor(point, radiusM);
    stroke = { mode: tool, radiusM, points: [{ lat: point.lat, lon: point.lng }] };
    const pixel = map.latLngToContainerPoint(point);
    const metresPerPixel = map.distance(point, map.containerPointToLatLng([pixel.x + 1, pixel.y]));
    line = L.polyline([point], { color: tool === 'paint' ? '#ed3d4f' : '#0878f9', weight: 2 * radiusM / metresPerPixel, opacity: 0.35, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(preview);
    return true;
  }
  document.addEventListener('mousemove', event => {
    if (!isActive() || !tool || busy) return;
    const bounds = container.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
      // Keep the active stroke until mouseup. Finishing as soon as the pointer
      // crossed the map edge made the rest of a fast drag disappear while the
      // operator was still holding the button.
      if (!stroke) clearPreview();
      return;
    }
    const point = position(event);
    showCursor(point, stroke?.radiusM ?? radiusAt(point));
    if (!stroke) return;
    if (!(event.buttons & 1)) { void finish(); return; }
    const last = stroke.points.at(-1);
    if (map.distance([last.lat, last.lon], point) < stroke.radiusM / 4) return;
    stroke.points.push({ lat: point.lat, lon: point.lng });
    line.addLatLng(point);
    if (stroke.points.length >= 256) void finish();
  });
  document.addEventListener('mouseup', event => { if (event.button === 0) void finish(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && tool) setTool(null); });
  window.addEventListener('blur', () => { if (stroke) void finish(); else clearPreview(); });
  map.on('zoomstart', () => { if (stroke) void finish(); else clearPreview(); });
  return { setTool, handleMouseDown, reset() { cancel(); tool = null; container.style.cursor = ''; } };
}
