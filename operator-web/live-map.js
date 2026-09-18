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

  function begin(target) {
    liveView = target;
    following = Boolean(target?.markerKey);
    centered = false;
    lastPosition = null;
    lastPanAt = 0;
    onFollowingChange(following);
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
    following = false;
    onFollowingChange(false);
  }

  function recenter() {
    if (!liveView) return;
    following = true;
    if (lastPosition) {
      map.setView(lastPosition, map.getZoom(), { animate: true });
      centered = true;
      lastPanAt = now();
    }
    onFollowingChange(true);
  }

  function end() {
    const entry = liveView ? markers.get(liveView.markerKey) : null;
    const result = {
      markerKey: liveView?.markerKey ?? null,
      liveOnly: Boolean(entry?.liveOnly),
      position: lastPosition,
    };
    if (entry && !entry.liveOnly) entry.marker.setStyle?.(FLEET_MARKER_STYLE);
    liveView = null;
    following = false;
    centered = false;
    lastPosition = null;
    lastPanAt = 0;
    onFollowingChange(false);
    return result;
  }

  return { begin, update, pause, recenter, end, isFollowing: () => following };
}
