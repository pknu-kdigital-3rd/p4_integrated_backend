/** Reject missing coordinates instead of converting them into a position at 0,0. */
export function fleetPosition(item) {
  const {latitude, longitude} = item?.telemetry || {};
  if ([latitude, longitude].some(value => value == null || String(value).trim() === '')) return null;
  const lat = Number(latitude), lon = Number(longitude);
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
    ? [lat, lon] : null;
}

export function createFleetViewport(map) {
  let saved = null, initialized = false;
  return {
    save() { saved = {center:map.getCenter(), zoom:map.getZoom()}; },
    restore() { if (saved) { map.invalidateSize({pan:false}); map.setView(saved.center,saved.zoom,{animate:false}); saved=null; } },
    fit(items, {initial = false} = {}) {
      if (initial && initialized) return;
      const positions = items.map(fleetPosition).filter(Boolean);
      if (!positions.length) return;
      initialized = true;
      map.invalidateSize({pan:false});
      map.fitBounds(positions, {paddingTopLeft:[45,145],paddingBottomRight:[45,65],maxZoom:15,animate:false});
    },
  };
}
