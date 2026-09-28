import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import { maplibreGL } from '@maplibre/maplibre-gl-leaflet';
import { addProtocol, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { Protocol } from 'pmtiles';
import mapStyle from './map-style.json';

// The dashboard and its existing plugins use Leaflet's global API.
window.L = L;
await import('leaflet-geometryutil');
await import('leaflet-arrowheads');

const protocol = new Protocol();
setWorkerUrl(workerUrl);
addProtocol('pmtiles', protocol.tile);
const style = structuredClone(mapStyle);
style.sources.openmaptiles.url = `pmtiles://${location.origin}/map-assets/busan.pmtiles`;
style.glyphs = `${location.origin}/map-assets/fonts/{fontstack}/{range}.pbf`;
style.sprite = `${location.origin}/map-assets/sprites/ofm`;
window.__createOperatorBaseLayer = (map) => maplibreGL({ style }).addTo(map);

await import('./app.js');
await import('./virtual-dispatch.js');
if (new URLSearchParams(location.search).get('workspace') === 'virtual') {
  document.querySelector('#virtual-workspace-tab').click();
}
