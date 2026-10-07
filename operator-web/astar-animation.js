/** Time-based replay of a bounded, ordered trace from the actual server search. */
export function createSearchReplay(trace, route, reducedMotion = false) {
  const events = trace.events || [], edges = new Map();
  let elapsed = 0, index = 0;
  const searchDuration = events.length ? 20000 : 0;
  function advance(delta, now = () => performance.now()) {
    elapsed += Math.max(0, delta);
    const target = reducedMotion ? events.length : Math.min(events.length, Math.floor(elapsed / searchDuration * events.length));
    const started = now();
    while (index < target) {
      const event = events[index++];
      if (event.edgeId && trace.edges[event.edgeId]) {
        if (event.kind === 'expanded' || !edges.has(event.edgeId)) edges.set(event.edgeId, event.kind);
      }
      if (!reducedMotion && now() - started >= 4) break;
    }
    // Back-pressure the timeline if processing the trace takes several frames.
    if (index < target) elapsed = Math.min(elapsed, searchDuration);
    const routeProgress = index < events.length ? 0 : reducedMotion ? 1 : Math.max(0, Math.min(1, (elapsed - searchDuration) / 5000));
    return { edges, routeProgress, index, total: events.length,
      done: index === events.length && routeProgress === 1, hasRoute: Boolean(route?.coordinates?.length) };
  }
  return { advance };
}

/** One non-interactive canvas; projected geometry is cached for each zoom level. */
export function installSearchAnimation(map, { onProgress, onDone, isCurrent }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'astar-search-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  const context = canvas.getContext('2d');
  let data = null, replay = null, state = null, frame = 0, previous = null, paused = false, speed = 1;
  let zoom = null, projected = {}, projectedRoute = [], routeLengths = [], routeTotal = 0;
  let zooming = false;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function project() {
    if (zoom === map.getZoom()) return;
    zoom = map.getZoom();
    const points = coords => coords.map(([lon, lat]) => map.project([lat, lon], zoom));
    projected = Object.fromEntries(Object.entries(data.searchTrace.edges).map(([id, coords]) => [id, points(coords)]));
    projectedRoute = points(data.routeGeojson?.coordinates || []);
    routeTotal = 0;
    routeLengths = projectedRoute.map((point, i) => {
      if (i) routeTotal += point.distanceTo(projectedRoute[i - 1]);
      return routeTotal;
    });
  }
  function draw() {
    if (!data || !state || zooming) return;
    project();
    const size = map.getSize(), ratio = window.devicePixelRatio || 1;
    canvas.width = size.x * ratio; canvas.height = size.y * ratio;
    canvas.style.width = `${size.x}px`; canvas.style.height = `${size.y}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    // Match Leaflet's container coordinates, including the map pane's pan
    // offset, rather than deriving a canvas origin from viewport bounds.
    const anchor = map.project([0, 0], zoom), containerAnchor = map.latLngToContainerPoint([0, 0]);
    const origin = { x: anchor.x - containerAnchor.x, y: anchor.y - containerAnchor.y };
    function path(points) {
      if (!points?.length) return;
      context.moveTo(points[0].x - origin.x, points[0].y - origin.y);
      for (let i = 1; i < points.length; i++) context.lineTo(points[i].x - origin.x, points[i].y - origin.y);
    }
    context.lineCap = 'round'; context.lineJoin = 'round'; context.lineWidth = 3;
    for (const [kind, color] of [['discovered', '#d97706'], ['expanded', '#2563eb']]) {
      context.beginPath(); context.strokeStyle = color;
      for (const [id, status] of state.edges) if (status === kind) path(projected[id]);
      context.stroke();
    }
    if (state.routeProgress > 0 && projectedRoute.length) {
      const target = routeTotal * state.routeProgress, points = [projectedRoute[0]];
      for (let i = 1; i < projectedRoute.length; i++) {
        if (routeLengths[i] <= target) points.push(projectedRoute[i]);
        else {
          const a = projectedRoute[i - 1], b = projectedRoute[i];
          const fraction = (target - routeLengths[i - 1]) / (routeLengths[i] - routeLengths[i - 1] || 1);
          points.push({ x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction }); break;
        }
      }
      context.beginPath(); context.lineWidth = 6; context.strokeStyle = '#16a34a'; path(points); context.stroke();
    }
  }
  function tick(time) {
    frame = 0;
    if (!data) return;
    if (!isCurrent()) { stop(); onDone(false); return; }
    if (!paused && !document.hidden && !zooming) {
      state = replay.advance(previous === null ? 0 : Math.min(100, time - previous) * speed);
      draw(); onProgress(state, data.searchTrace.truncated);
    }
    previous = paused || document.hidden || zooming ? null : time;
    if (state?.done) { onDone(true); return; }
    if (!paused && !document.hidden) frame = requestAnimationFrame(tick);
  }
  function schedule() { previous = null; if (data && !frame && !paused && !document.hidden && !state?.done) frame = requestAnimationFrame(tick); }
  function beginZoom() { zooming = true; previous = null; canvas.style.visibility = 'hidden'; }
  function endZoom() {
    zooming = false; zoom = null; previous = null;
    draw(); canvas.style.visibility = ''; schedule();
  }
  function stop() {
    cancelAnimationFrame(frame); frame = 0; previous = null; data = null; state = null;
    map.off('move moveend resize viewreset', draw);
    map.off('zoomstart', beginZoom); map.off('zoomend', endZoom);
    document.removeEventListener('visibilitychange', schedule);
    canvas.remove();
  }
  return {
    start(result, { animate = false } = {}) {
      stop(); data = result; zoom = null; paused = false; zooming = false; canvas.style.visibility = '';
      // Replay is an explicit request to watch motion, even when the initial
      // result was displayed immediately for the system's reduced-motion setting.
      replay = createSearchReplay(result.searchTrace, result.routeGeojson, reduced && !animate);
      state = replay.advance(0); map.getContainer().append(canvas);
      map.on('move moveend resize viewreset', draw);
      map.on('zoomstart', beginZoom); map.on('zoomend', endZoom);
      document.addEventListener('visibilitychange', schedule);
      draw(); onProgress(state, result.searchTrace.truncated);
      if (state.done) onDone(true); else schedule();
    },
    pause(value) { paused = value; if (paused) { cancelAnimationFrame(frame); frame = 0; } else schedule(); },
    setSpeed(value) { speed = value; },
    stop,
  };
}
