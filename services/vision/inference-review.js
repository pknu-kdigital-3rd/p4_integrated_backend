// Local-file player: indexed reads, bounded prefetch and seek-generation guards.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.InferenceReview = api; api.start(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function frameIndex(frames, pts) {
    let low = 0, high = frames.length;
    while (low < high) { const mid = (low + high) >>> 1; if (frames[mid][0] <= pts) low = mid + 1; else high = mid; }
    return Math.max(0, low - 1);
  }
  function validateManifest(manifest, resultsSize) {
    if (manifest.version !== 1 || manifest.complete !== true || manifest.time_base !== 90000
        || !Number.isInteger(manifest.width) || manifest.width < 1
        || !Number.isInteger(manifest.height) || manifest.height < 1
        || !(manifest.duration > 0) || !Array.isArray(manifest.frames)
        || !manifest.frames.length || manifest.frame_count !== manifest.frames.length
        || manifest.results.size !== resultsSize) throw new Error('Unsupported or incomplete bundle');
    let previous = -1, end = 0;
    for (const row of manifest.frames) {
      if (row.length !== 3 || !row.every(Number.isSafeInteger) || row[0] <= previous
          || row[1] !== end || row[2] < 1 || row[2] > 8 * 1024 * 1024) throw new Error('Invalid frame index');
      previous = row[0]; end = row[1] + row[2];
    }
    if (end !== resultsSize) throw new Error('Incomplete result index');
  }
  class ResultReader {
    constructor(file, manifest) { this.file = file; this.manifest = manifest; this.cache = new Map(); this.generation = 0; }
    reset() { this.generation++; this.cache.clear(); }
    async read(index, prefetch = false) {
      if (!prefetch) for (const key of this.cache.keys()) if (key < index - 2 || key > index + 12) this.cache.delete(key);
      if (this.cache.has(index)) return this.cache.get(index);
      const generation = this.generation;
      const [pts, offset, length] = this.manifest.frames[index];
      const promise = this.file.slice(offset, offset + length).text().then(text => {
        const row = JSON.parse(text), result = row.result;
        if (row.pts_90k !== pts || !result || !Array.isArray(result.items)
            || result.width !== this.manifest.width || result.height !== this.manifest.height)
          throw new Error(`Invalid inference for frame ${index}`);
        return result;
      });
      this.cache.set(index, promise);
      // Keep only a bounded window. Old generations may finish, but cannot
      // insert records into or paint over a newly selected seek position.
      try { return await promise; }
      catch (error) { if (generation === this.generation) this.cache.delete(index); throw error; }
    }
    prefetch(index) {
      for (let i = index + 1; i < Math.min(index + 9, this.manifest.frames.length); i++) this.read(i, true).catch(() => {});
    }
  }
  async function fingerprint(file) {
    const first = await file.slice(0, Math.min(file.size, 1048576)).arrayBuffer();
    const last = await file.slice(Math.max(0, file.size - 1048576)).arrayBuffer();
    const bytes = new Uint8Array(first.byteLength + last.byteLength);
    bytes.set(new Uint8Array(first)); bytes.set(new Uint8Array(last), first.byteLength);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  }
  function start() {
    const el = id => document.getElementById(id), video = el('decoder');
    const picture = el('picture'), overlay = el('overlay'), status = el('status');
    let manifest, reader, objectUrl, generation = 0, request = 0, currentIndex = 0, currentResult, loop = null;
    let callback = null, paintVersion = 0;
    const snapshot = document.createElement('canvas');
    function fail(error) { video.pause(); status.textContent = error.message; }
    function draw() {
      if (!currentResult) return;
      LiveViewOverlay.draw(overlay.getContext('2d'), currentResult.items, manifest.width, manifest.height, {
        boxes: el('boxes').checked, masks: el('masks').checked, distances: el('distances').checked,
        minConfidence: Number(el('confidence').value), distanceColors: LiveViewDistanceColors,
        distanceSettings: LiveViewDistanceColors.normalizeSettings({ ...LiveViewDistanceColors.DEFAULTS, enabled: el('distance-colors').checked }),
      });
    }
    async function present(mediaTime) {
      if (!reader || video.seeking || video.readyState < 2) return;
      const version = ++paintVersion, epoch = generation;
      const index = frameIndex(manifest.frames, Math.round(mediaTime * 90000));
      if (loop && manifest.frames[index][0] / 90000 >= loop[1]) { seek(loop[0]); return; }
      // Capture this video's frame before awaiting a disk read. Painting the
      // snapshot and its result together prevents overlays over another frame.
      snapshot.getContext('2d').drawImage(video, 0, 0, snapshot.width, snapshot.height);
      const image = await createImageBitmap(snapshot);
      try {
        const result = await reader.read(index);
        if (epoch !== generation || version !== paintVersion) return;
        picture.getContext('2d').drawImage(image, 0, 0);
        currentIndex = index; currentResult = result; draw();
        el('timeline').value = String(manifest.frames[index][0] / 90000);
        el('position').textContent = `${(manifest.frames[index][0] / 90000).toFixed(3)} / ${manifest.duration.toFixed(3)} s · frame ${index + 1}/${manifest.frame_count}`;
        status.textContent = `${manifest.model_filename} · ${result.items.length} objects · saved depth: ${result.depth?.status || 'unavailable'}`;
        reader.prefetch(index);
      } catch (error) {
        if (epoch === generation && version === paintVersion) throw error;
      } finally { image.close(); }
    }
    function tick(_now, metadata) {
      callback = null;
      present(metadata.mediaTime).catch(fail);
      callback = video.requestVideoFrameCallback(tick);
    }
    function seek(seconds) {
      if (!manifest) return;
      generation++; paintVersion++; reader.reset(); currentResult = null;
      overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
      const timestamp = Math.round(seconds * 90000);
      let index = frameIndex(manifest.frames, timestamp);
      if (manifest.frames[index][0] < timestamp && index + 1 < manifest.frames.length) index++;
      // Seek inside the selected frame interval, rather than just before it
      // due to floating point rounding. Keep the original PTS for lookup.
      const next = manifest.frames[index + 1]?.[0] ?? manifest.duration * 90000;
      video.currentTime = (manifest.frames[index][0] + Math.min(1, (next - manifest.frames[index][0]) / 2)) / 90000;
    }
    el('load').onclick = async () => {
      const loadRequest = ++request;
      try {
        generation++; paintVersion++; video.pause();
        if (callback !== null) video.cancelVideoFrameCallback(callback);
        callback = null; el('controls').disabled = true; reader?.reset(); reader = null; currentResult = null;
        overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
        const media = el('video-file').files[0], info = el('manifest-file').files[0], results = el('results-file').files[0];
        if (!media || !info || !results) throw new Error('Select video, manifest and inference files first.');
        if (!video.requestVideoFrameCallback || !window.createImageBitmap || !crypto.subtle)
          throw new Error('This viewer requires a current Chrome or Edge browser.');
        const candidate = JSON.parse(await info.text());
        validateManifest(candidate, results.size);
        status.textContent = 'Checking bundle identity…';
        if (media.size !== candidate.video.size || await fingerprint(media) !== candidate.video.sample_sha256)
          throw new Error('Selected video does not match this bundle.');
        if (await fingerprint(results) !== candidate.results.sample_sha256)
          throw new Error('Selected inference file does not match this bundle.');
        if (loadRequest !== request) return;
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        manifest = candidate; reader = new ResultReader(results, manifest); loop = null;
        objectUrl = URL.createObjectURL(media);
        await new Promise((resolve, reject) => {
          video.onloadeddata = resolve; video.onerror = () => reject(new Error('Browser could not decode the generated MP4.'));
          video.src = objectUrl;
        });
        if (loadRequest !== request) return;
        video.onloadeddata = null;
        if (video.videoWidth !== manifest.width || video.videoHeight !== manifest.height
            || Math.abs(video.duration - manifest.duration) > 0.1) throw new Error('Video timing/dimensions do not match the manifest.');
        picture.width = overlay.width = snapshot.width = manifest.width;
        picture.height = overlay.height = snapshot.height = manifest.height;
        el('stage').style.aspectRatio = `${manifest.width}/${manifest.height}`;
        el('timeline').max = String(manifest.frames.at(-1)[0] / 90000);
        el('loop-end').value = String(manifest.duration); el('controls').disabled = false;
        await present(0);
        if (loadRequest === request) callback = video.requestVideoFrameCallback(tick);
      } catch (error) { if (loadRequest === request) fail(error); }
    };
    video.onseeked = () => present(video.currentTime).catch(fail);
    video.onended = () => { if (loop) { seek(loop[0]); video.play().catch(fail); } };
    el('play').onclick = () => video.paused ? video.play().catch(fail) : video.pause();
    el('timeline').onchange = () => seek(Number(el('timeline').value));
    for (const [id, delta] of [['previous', -1], ['next', 1]]) el(id).onclick = () => {
      video.pause(); const index = Math.max(0, Math.min(manifest.frames.length - 1, currentIndex + delta));
      seek(manifest.frames[index][0] / 90000);
    };
    el('loop').onclick = () => {
      const start = Number(el('loop-start').value), end = Number(el('loop-end').value);
      if (!(0 <= start && start < end && end <= manifest.duration)) { status.textContent = 'Loop requires 0 ≤ start < end ≤ video duration.'; return; }
      let index = frameIndex(manifest.frames, Math.round(start * 90000));
      if (manifest.frames[index][0] < Math.round(start * 90000)) index++;
      if (!manifest.frames[index] || manifest.frames[index][0] / 90000 >= end) { status.textContent = 'No video frames in the selected interval.'; return; }
      loop = [start, end]; seek(start);
    };
    el('clear-loop').onclick = () => { loop = null; };
    for (const id of ['boxes', 'masks', 'distances', 'distance-colors', 'confidence']) el(id).oninput = draw;
  }
  return { frameIndex, validateManifest, ResultReader, fingerprint, start };
});
