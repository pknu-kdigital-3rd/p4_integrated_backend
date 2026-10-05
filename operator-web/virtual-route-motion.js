/** Sample the immutable route by distance, preserving corners and loops. */
export function createVirtualRouteMotion(geometry) {
  if (geometry?.type !== 'LineString' || !Array.isArray(geometry.coordinates)) return null;
  const points = geometry.coordinates.map(pair => ({ lat: Number(pair?.[1]), lon: Number(pair?.[0]) }));
  if (points.length < 2 || points.some(point => !Number.isFinite(point.lat) || !Number.isFinite(point.lon))) return null;
  const lengths = points.slice(1).map((point, index) => {
    const from = points[index], radians = Math.PI / 180;
    const h = Math.sin((point.lat - from.lat) * radians / 2) ** 2
      + Math.cos(from.lat * radians) * Math.cos(point.lat * radians) * Math.sin((point.lon - from.lon) * radians / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
  });
  const total = lengths.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return null;
  return {
    total,
    sample(offsetM) {
      const target = Math.max(0, Math.min(total, offsetM));
      let traversed = 0;
      for (let index = 0; index < lengths.length; index++) {
        const length = lengths[index];
        if (length > 0 && target <= traversed + length) {
          const ratio = (target - traversed) / length;
          const from = points[index], to = points[index + 1];
          return { lat: from.lat + (to.lat - from.lat) * ratio, lon: from.lon + (to.lon - from.lon) * ratio };
        }
        traversed += length;
      }
      return points.at(-1);
    },
  };
}
