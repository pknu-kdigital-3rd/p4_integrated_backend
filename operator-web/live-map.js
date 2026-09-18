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

/** Centers the map on the first Android GPS marker for each recording session. */
export function createAndroidMarkerRevealer({ map, minimumZoom = 15 }) {
  const revealedSessions = new Set();
  return (item, position) => {
    if (!isAndroidGpsItem(item)) return false;
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
    entry.marker.setLatLng(position);
    lastPosition = position;

    if (following) {
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
    return entry;
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

  return { begin, update, pause, recenter, end, centerOnVehicle, isFollowing: () => following };
}
