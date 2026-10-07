/** Time-based replay of a bounded, ordered trace from the actual server search. */
export function createSearchReplay(trace, route, reducedMotion = false) {
  const events = trace.events || [], edges = new Map();
  let elapsed = 0, index = 0;
  const searchDuration = events.length ? 20000 : 0;
  function advance(delta, now = () => performance.now()) {
    const changedEdges = new Map();
    elapsed += Math.max(0, delta);
    const target = reducedMotion ? events.length : Math.min(events.length, Math.floor(elapsed / searchDuration * events.length));
    const started = now();
    while (index < target) {
      const event = events[index++];
      if (event.edgeId && trace.edges[event.edgeId]) {
        if (!edges.has(event.edgeId) || (event.kind === 'expanded' && edges.get(event.edgeId) !== 'expanded')) {
          edges.set(event.edgeId, event.kind);
          changedEdges.set(event.edgeId, event.kind);
        }
      }
      if (!reducedMotion && now() - started >= 4) break;
    }
    // Back-pressure the timeline if processing the trace takes several frames.
    if (index < target) elapsed = Math.min(elapsed, searchDuration);
    const routeProgress = index < events.length ? 0 : reducedMotion ? 1 : Math.max(0, Math.min(1, (elapsed - searchDuration) / 5000));
    return { edges, changedEdges, routeProgress, index, total: events.length,
      done: index === events.length && routeProgress === 1, hasRoute: Boolean(route?.coordinates?.length) };
  }
  return { advance };
}

/** One visible canvas composites persistent discovery/expansion raster caches. */
export function installSearchAnimation(map, { onProgress, onDone, isCurrent }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'astar-search-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  const context = canvas.getContext('2d');
  const caches = ['discovered', 'expanded'].map(kind => {
    const canvas = document.createElement('canvas');
    return { kind, canvas, context: canvas.getContext('2d') };
  });
  let data = null, replay = null, state = null, frame = 0, previous = null, paused = false, speed = 1;
  let zoom = null, projected = {}, projectedRoute = [], routeLengths = [], routeTotal = 0;
  let zooming = false;
  let viewKey = null;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function project() {
    if (zoom === map.getZoom()) return;
    zoom = map.getZoom();
    const points = coords => coords.map(([lon, lat]) => map.project([lat, lon], zoom));
    projected = {};
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
    // Match Leaflet's container coordinates, including the map pane's pan
    // offset, rather than deriving a canvas origin from viewport bounds.
    const anchor = map.project([0, 0], zoom), containerAnchor = map.latLngToContainerPoint([0, 0]);
    const origin = { x: anchor.x - containerAnchor.x, y: anchor.y - containerAnchor.y };
    const nextViewKey = [zoom, origin.x, origin.y, size.x, size.y, ratio].join('/');
    const rebuild = viewKey !== nextViewKey;
    viewKey = nextViewKey;
    const width = Math.round(size.x * ratio), height = Math.round(size.y * ratio);
    for (const surface of [canvas, ...caches.map(cache => cache.canvas)]) {
      if (surface.width !== width) surface.width = width;
      if (surface.height !== height) surface.height = height;
    }
    canvas.style.width = `${size.x}px`; canvas.style.height = `${size.y}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    function path(ctx, points) {
      if (!points?.length) return;
      ctx.moveTo(points[0].x - origin.x, points[0].y - origin.y);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x - origin.x, points[i].y - origin.y);
    }
    const changes = rebuild ? state.edges : state.changedEdges;
    for (const { kind, context: ctx } of caches) {
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      if (rebuild) ctx.clearRect(0, 0, size.x, size.y);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.strokeStyle = kind === 'discovered' ? '#d97706' : '#2563eb';
      for (const [id, status] of changes) if (status === kind) {
        // Project only roads reached by playback; reuse them until zoom changes.
        projected[id] ||= data.searchTrace.edges[id].map(([lon, lat]) => map.project([lat, lon], zoom));
        path(ctx, projected[id]);
      }
      ctx.stroke();
    }
    // Map events can draw between animation ticks. Consume each update once.
    state.changedEdges.clear();
    context.clearRect(0, 0, size.x, size.y);
    for (const cache of caches) context.drawImage(cache.canvas, 0, 0, size.x, size.y);
    context.lineCap = 'round'; context.lineJoin = 'round';
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
      context.beginPath(); context.lineWidth = 6; context.strokeStyle = '#16a34a'; path(context, points); context.stroke();
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
      stop(); data = result; zoom = null; viewKey = null; paused = false; zooming = false; canvas.style.visibility = '';
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
