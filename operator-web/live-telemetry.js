// Presented-frame telemetry from the Vision live-view iframe drives the selected
// vehicle's marker while Live View is open; the 3-second fleet poll keeps
// driving every other marker. Nothing here is persisted: display positions
// (interpolated/extrapolated by Vision) never become GPS observations.

export const LIVE_TELEMETRY_MESSAGE = 'live-vehicle-telemetry';
// Without a fresh presented frame for this long, the live override is released
// and the marker falls back to fleet polling instead of freezing forever.
export const LIVE_OVERRIDE_STALE_MS = 3000;

/** Live-view target captured from the vehicle selected when Live View opened. */
export function createLiveView(item, frameOrigin) {
  const metadata = item?.telemetry?.source_metadata || {};
  return {
    markerKey: item?.telemetry?.external_id ?? null,
    vehicleId: item?.vehicleId != null ? String(item.vehicleId) : null,
    tripId: item?.tripId != null ? String(item.tripId) : null,
    // Unknown until the tracking snapshot or the first accepted frame names it.
    recordingSessionId: typeof metadata.recordingSessionId === 'string' ? metadata.recordingSessionId : null,
    frameOrigin,
    lastUpdateAt: 0,
    lastStatus: null,
  };
}

/**
 * Returns the telemetry payload when the message is a presented-frame update
 * for this live view, or null when it must be ignored.
 * Checks: exact iframe origin, the iframe window itself, message type, and the
 * vehicle/trip/session identity of the currently selected live view.
 */
export function acceptLiveTelemetry(liveView, event, frameWindow) {
  if (!liveView || !event || !frameWindow) return null;
  if (event.origin !== liveView.frameOrigin) return null;
  if (event.source !== frameWindow) return null;
  const data = event.data;
  if (!data || typeof data !== 'object' || data.type !== LIVE_TELEMETRY_MESSAGE) return null;
  const recording = data.recording;
  if (!recording || typeof recording !== 'object') return null;
  if (!liveView.vehicleId || String(recording.vehicleId) !== liveView.vehicleId) return null;
  if (liveView.tripId && String(recording.tripId) !== liveView.tripId) return null;
  if (liveView.recordingSessionId && recording.recordingSessionId !== liveView.recordingSessionId) return null;
  if (!liveView.recordingSessionId && typeof recording.recordingSessionId !== 'string') return null;
  return data.telemetry && typeof data.telemetry === 'object' ? data : null;
}

/** Records an accepted update; returns the display position or null. */
export function applyLiveTelemetry(liveView, message, now) {
  if (!liveView.recordingSessionId) liveView.recordingSessionId = message.recording.recordingSessionId;
  liveView.lastStatus = message.telemetry.status ?? null;
  const gps = message.telemetry.gps;
  if (!gps || !Number.isFinite(gps.latitude) || !Number.isFinite(gps.longitude)) return null;
  liveView.lastUpdateAt = now;
  return [gps.latitude, gps.longitude];
}

/** True while the live view owns this marker's position. */
export function isLiveOverride(liveView, markerKey, now) {
  return Boolean(liveView && markerKey && liveView.markerKey === markerKey
    && liveView.lastUpdateAt > 0 && now - liveView.lastUpdateAt <= LIVE_OVERRIDE_STALE_MS);
}

/** Operator-facing status text and level for the live telemetry line. */
export function describeLiveTelemetry(liveView, message, now) {
  if (!liveView) return { text: 'Live telemetry: closed', level: 'idle' };
  if (!liveView.lastUpdateAt && !message) return { text: 'Live telemetry: waiting for synchronized frames', level: 'idle' };
  if (liveView.lastUpdateAt && now - liveView.lastUpdateAt > LIVE_OVERRIDE_STALE_MS) {
    return { text: 'Live telemetry: stale - marker follows fleet polling', level: 'warn' };
  }
  const telemetry = message?.telemetry || {};
  const gps = telemetry.gps;
  const labels = {
    ok: 'synchronized', gps_stale: 'GPS stale', imu_stale: 'IMU stale', stale: 'GPS and IMU stale',
    waiting_for_telemetry: 'waiting for telemetry', source_timestamp_unavailable: 'source timestamp unavailable',
    session_mismatch: 'session mismatch',
  };
  const parts = [`Live telemetry: ${labels[telemetry.status] || telemetry.status || 'unknown'}`];
  if (gps) {
    if (gps.speed_kmh != null) parts.push(`${Number(gps.speed_kmh).toFixed(1)} km/h`);
    if (gps.bearing_deg != null) parts.push(`${Number(gps.bearing_deg).toFixed(0)}°`);
    if (gps.accuracy_quality && gps.accuracy_quality !== 'normal') parts.push(`accuracy ${gps.accuracy_quality}`);
    if (telemetry.match?.gps) parts.push(`gps ${telemetry.match.gps}`);
  }
  return { text: parts.join(' · '), level: telemetry.status === 'ok' ? 'ok' : 'warn' };
}
