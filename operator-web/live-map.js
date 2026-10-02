export const LIVE_MARKER_STYLE = {
  color: '#ffffff',
  weight: 3,
  fillColor: '#ff8a3d',
  fillOpacity: 1,
};

export const FLEET_MARKER_STYLE = {
  color: '#ffffff',
  weight: 1,
  fillColor: '#16c79a',
  fillOpacity: 0.9,
};

export const ANDROID_GPS_MARKER_STYLE = {
  color: '#ffffff',
  weight: 3,
  fillColor: '#9b59ff',
  fillOpacity: 1,
};

export function isAndroidGpsItem(item) {
  return ['DEVICE_GPS', 'RECORDED_GPS'].includes(item?.telemetry?.telemetry_source);
}

export function fleetMarkerStyle(item) {
  return isAndroidGpsItem(item) ? ANDROID_GPS_MARKER_STYLE : FLEET_MARKER_STYLE;
}

// --- Marker position ownership -------------------------------------------
// A fleet poll glides a marker to its new fix over the 3-second poll
// interval, one animation callback per frame. A live-frame update must take
// the marker over at once: before, update() set the frame position but the
// glide's already-scheduled callbacks kept writing older interpolated
// positions over it for the rest of the glide. Each glide now carries a
// token; cancelGlide() both cancels the queued callback and invalidates the
// token, so no callback of a superseded glide can write again.

const GLIDE_JUMP_M = 1000;

function scheduleFrame(callback) {
  return typeof requestAnimationFrame === 'function' ? requestAnimationFrame(callback) : setTimeout(() => callback(performance.now()), 16);
}

function cancelFrame(id) {
  if (id == null) return;
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
  else clearTimeout(id);
}

function latLngPair(value) {
  if (Array.isArray(value)) return [Number(value[0]), Number(value[1])];
  return [Number(value?.lat), Number(value?.lng ?? value?.lon)];
}

function distanceM(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Stops the marker's glide for good; a queued callback finds its token stale. */
export function cancelGlide(marker, cancel = cancelFrame) {
  if (!marker) return;
  cancel(marker.glideFrame);
  marker.glideFrame = null;
  marker.glideToken = (marker.glideToken ?? 0) + 1;
}

/**
 * Moves a marker smoothly to target over durationMs instead of jumping; a
 * hidden page or a jump over 1 km (a new vehicle, a seek) is applied at once.
 * The scheduler is injectable for tests.
 */
export function glideMarker(marker, target, durationMs, {
  schedule = scheduleFrame,
  cancel = cancelFrame,
  now = () => performance.now(),
  hidden = () => typeof document !== 'undefined' && document.hidden,
} = {}) {
  cancelGlide(marker, cancel);
  const to = latLngPair(target);
  const current = marker.getLatLng?.();
  const from = current ? latLngPair(current) : null;
  if (!from || !from.every(Number.isFinite) || hidden() || distanceM(from, to) > GLIDE_JUMP_M) {
    marker.setLatLng(to);
    return;
  }
  const token = marker.glideToken;
  const started = now();
  const step = (time) => {
    if (marker.glideToken !== token) return;
    const t = Math.min(1, (time - started) / durationMs);
    marker.setLatLng([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]);
    marker.glideFrame = t < 1 ? schedule(step) : null;
  };
  marker.glideFrame = schedule(step);
}

/** Centers the map on the first Android GPS marker for each recording session. */
export function createAndroidMarkerRevealer({ map, minimumZoom = 15 }) {
  const revealedSessions = new Set();
  return (item, position) => {
    if (item?.telemetry?.telemetry_source !== 'DEVICE_GPS') return false;
    if (!Array.isArray(position) || !position.every(Number.isFinite)) return false;
    const telemetry = item.telemetry;
    const markerKey = telemetry.external_id || 'android-device';
    const sessionId = telemetry.source_metadata?.recordingSessionId || 'default-session';
    const revealKey = `${markerKey}:${sessionId}`;
    if (revealedSessions.has(revealKey)) return false;
    revealedSessions.add(revealKey);
    map.setView(position, Math.max(map.getZoom(), minimumZoom), { animate: false });
    return true;
  };
}

/**
 * Owns the selected vehicle marker and map-follow behavior while Live View is
 * open. Map and marker objects are injected so the behavior is unit-testable.
 */
export function createLiveMapFollower({
  map,
  markers,
  createEntry,
  onFollowingChange = () => {},
  now = () => Date.now(),
  panIntervalMs = 250,
}) {
  let liveView = null;
  let following = false;
  let centered = false;
  let lastPosition = null;
  let lastPanAt = 0;
  const scrollWheelZoomMode = map.options?.scrollWheelZoom;

  function setFollowing(value) {
    following = value;
    // Leaflet normally zooms the wheel around the cursor. While following,
    // anchor that zoom at the map center, which tracks the vehicle.
    if (scrollWheelZoomMode) map.options.scrollWheelZoom = value ? 'center' : scrollWheelZoomMode;
    onFollowingChange(value);
  }

  function centerOnVehicle(animate = false) {
    if (!liveView?.markerKey || !following || !lastPosition) return false;
    map.setView(lastPosition, map.getZoom(), { animate });
    centered = true;
    lastPanAt = now();
    return true;
  }

  function begin(target) {
    liveView = target;
    setFollowing(Boolean(target?.markerKey));
    centered = false;
    const telemetry = target?.item?.telemetry;
    lastPosition = Number.isFinite(telemetry?.latitude) && Number.isFinite(telemetry?.longitude)
      ? [telemetry.latitude, telemetry.longitude]
      : null;
    lastPanAt = 0;
    if (following && lastPosition) centerOnVehicle();
  }

  function update(position) {
    if (!liveView?.markerKey || !Array.isArray(position)
      || position.length !== 2 || !position.every(Number.isFinite)) return null;

    let entry = markers.get(liveView.markerKey);
    if (!entry) {
      entry = createEntry(liveView.item, position);
      entry.liveOnly = true;
      markers.set(liveView.markerKey, entry);
    }
    entry.marker.setStyle?.(LIVE_MARKER_STYLE);
    // The frame position owns the marker now; a fleet glide must not
    // overwrite it with an older interpolated position.
    cancelGlide(entry.marker);
    entry.marker.setLatLng(position);
    follow(position);
    return entry;
  }

  /**
   * Keeps the camera on position without moving the marker. For a vehicle
   * whose marker something else places (the replay vehicle on its route), so
   * the camera and the marker never get two different positions.
   */
  function follow(position) {
    if (!liveView?.markerKey || !Array.isArray(position)
      || position.length !== 2 || !position.every(Number.isFinite)) return;
    lastPosition = position;
    if (!following) return;
    const timestamp = now();
    if (!centered) {
      map.setView(position, map.getZoom(), { animate: false });
      centered = true;
      lastPanAt = timestamp;
    } else if (timestamp - lastPanAt >= panIntervalMs) {
      map.panTo(position, { animate: true, duration: panIntervalMs / 1000 });
      lastPanAt = timestamp;
    }
  }

  function pause() {
    if (!liveView || !following) return;
    setFollowing(false);
  }

  function recenter() {
    if (!liveView) return;
    setFollowing(true);
    centerOnVehicle(true);
  }

  function end() {
    const entry = liveView ? markers.get(liveView.markerKey) : null;
    const result = {
      markerKey: liveView?.markerKey ?? null,
      liveOnly: Boolean(entry?.liveOnly),
      position: lastPosition,
    };
    if (entry && !entry.liveOnly) {
      entry.marker.setStyle?.(fleetMarkerStyle(entry.item));
      entry.marker.setRadius?.(isAndroidGpsItem(entry.item) ? 10 : 8);
    }
    liveView = null;
    setFollowing(false);
    centered = false;
    lastPosition = null;
    lastPanAt = 0;
    return result;
  }

  map.on?.('zoomend', () => centerOnVehicle());

  return { begin, update, follow, pause, recenter, end, centerOnVehicle, isFollowing: () => following };
}
