function cross(a, b) {
  return a[0] * b[1] - a[1] * b[0];
}

function pointAt(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function samePoint(a, b) {
  return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
}

function boundaryParameters(a, b, ring) {
  const parameters = [];
  for (let index = 0; index < ring.length - 1; index += 1) {
    const c = ring[index], d = ring[index + 1];
    const road = [b[0] - a[0], b[1] - a[1]];
    const edge = [d[0] - c[0], d[1] - c[1]];
    const offset = [c[0] - a[0], c[1] - a[1]];
    const denominator = cross(road, edge);
    if (Math.abs(denominator) < 1e-12) continue;
    const t = cross(offset, edge) / denominator;
    const u = cross(offset, road) / denominator;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) parameters.push(t);
  }
  return parameters;
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i], b = ring[j];
    const crosses = (a[1] > point[1]) !== (b[1] > point[1])
      && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0];
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point, rings) {
  return rings.length > 0 && pointInRing(point, rings[0])
    && !rings.slice(1).some((hole) => pointInRing(point, hole));
}

function clipLineToPolygon(line, rings) {
  const paths = [];
  let current = null;
  const flush = () => {
    if (current?.length > 1) paths.push(current);
    current = null;
  };
  for (let i = 0; i < line.length - 1; i += 1) {
    const a = line[i], b = line[i + 1];
    const parameters = [0, 1];
    for (const ring of rings) parameters.push(...boundaryParameters(a, b, ring));
    parameters.sort((x, y) => x - y);
    const unique = parameters.filter((value, index) => index === 0 || Math.abs(value - parameters[index - 1]) > 1e-9);
    for (let index = 0; index < unique.length - 1; index += 1) {
      const start = unique[index], end = unique[index + 1];
      if (end - start < 1e-10 || !pointInPolygon(pointAt(a, b, (start + end) / 2), rings)) {
        flush();
        continue;
      }
      const from = pointAt(a, b, start), to = pointAt(a, b, end);
      if (current && samePoint(current[current.length - 1], from)) current.push(to);
      else { flush(); current = [from, to]; }
    }
  }
  flush();
  return paths;
}

function polygonsOf(geometry) {
  const value = geometry?.type === 'Feature' ? geometry.geometry : geometry;
  if (value?.type === 'Polygon') return [value.coordinates];
  if (value?.type === 'MultiPolygon') return value.coordinates;
  return [];
}

function lineParts(geometry) {
  if (geometry?.type === 'LineString') return [geometry.coordinates];
  if (geometry?.type === 'MultiLineString') return geometry.coordinates;
  return [];
}

export function restrictionRoadSegments(maplibreMap, restrictions) {
  if (!maplibreMap?.isStyleLoaded?.()) return [];
  let roads;
  try { roads = maplibreMap.querySourceFeatures('openmaptiles', { sourceLayer: 'transportation' }); }
  catch { return []; }

  const output = [];
  const seen = new Set();
  for (const restriction of restrictions || []) {
    if (restriction?.isActive === false) continue;
    const polygons = polygonsOf(restriction.geometry);
    const key = restriction.kind === 'HEAVY_PENALTY' ? 'penalty' : 'blocked';
    for (const road of roads) {
      for (const line of lineParts(road.geometry)) {
        if (!Array.isArray(line) || line.length < 2) continue;
        for (const polygon of polygons) {
          for (const segment of clipLineToPolygon(line, polygon)) {
            const signature = `${key}:${JSON.stringify(segment.map(([lng, lat]) => [Number(lng.toFixed(6)), Number(lat.toFixed(6))]))}`;
            if (seen.has(signature)) continue;
            seen.add(signature);
            output.push({ kind: key, coordinates: segment });
          }
        }
      }
    }
  }
  return output;
}
