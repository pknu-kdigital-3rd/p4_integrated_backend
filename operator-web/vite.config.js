import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mapRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/map');

function localMapAssets() {
  return {
    name: 'local-map-assets',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        let pathname;
        try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
        catch { response.statusCode = 400; response.end(); return; }
        if (!pathname.startsWith('/map-assets/')) { next(); return; }
        if (!['GET', 'HEAD'].includes(request.method)) { response.statusCode = 405; response.end(); return; }
        const relative = pathname.slice('/map-assets/'.length);
        const target = path.resolve(mapRoot, relative);
        if (!target.startsWith(mapRoot + path.sep)) { response.statusCode = 403; response.end(); return; }
        let stat;
        try { stat = fs.statSync(target); }
        catch { response.statusCode = 404; response.end('Map asset missing. Run the offline map setup.'); return; }
        if (!stat.isFile()) { response.statusCode = 404; response.end(); return; }
        const contentType = target.endsWith('.pbf') ? 'application/x-protobuf'
          : target.endsWith('.json') ? 'application/json'
          : target.endsWith('.png') ? 'image/png'
          : 'application/octet-stream';
        const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
        const start = match ? Number(match[1]) : 0;
        const end = match && match[2] ? Number(match[2]) : stat.size - 1;
        if (start > end || end >= stat.size) {
          response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); response.end(); return;
        }
        response.writeHead(match ? 206 : 200, {
          'Accept-Ranges': 'bytes', 'Content-Type': contentType,
          'Content-Length': end - start + 1,
          ...(match ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {})
        });
        if (request.method === 'HEAD') { response.end(); return; }
        fs.createReadStream(target, { start, end }).pipe(response);
      });
    }
  };
}

export default defineConfig({
  base: '/operator/',
  plugins: [localMapAssets()],
  build: { target: 'es2022' },
  server: { port: 5173, strictPort: true }
});
