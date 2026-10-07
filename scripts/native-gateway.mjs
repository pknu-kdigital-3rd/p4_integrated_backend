// Rootless ingress for native/Jupyter deployments. No npm packages required.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

export function targetFor(path, env) {
  if (path === '/live') return {redirect: '/live/'};
  if (path.startsWith('/live/')) return {origin: env.NATIVE_VISION_URL, path: path.slice(5)};
  if (path.split('?')[0] === '/ws/playback') return {origin: env.NATIVE_VISION_URL, path};
  if (path === '/health/vision') return {origin: env.NATIVE_VISION_URL, path: '/health/live'};
  if (path === '/health/routing') return {origin: env.NATIVE_ROUTING_URL, path: '/health/live'};
  for (const [prefix, origin] of [
    ['/osm/', 'https://tile.openstreetmap.org'],
    ['/basemap/', 'https://tiles.openfreemap.org'],
    ['/basemap-assets/', 'https://assets.openfreemap.com'],
  ]) {
    if (path.startsWith(prefix)) return {origin, path: `/${path.slice(prefix.length)}`, external: true, prefix};
  }
  return {origin: env.NATIVE_NODE_URL, path};
}

function headersFor(req, target, protocol) {
  const headers = {...req.headers};
  delete headers['proxy-authorization'];
  delete headers['proxy-connection'];
  if (target.external) {
    headers.host = new URL(target.origin).host;
    delete headers.authorization;
    delete headers.cookie;
    headers['user-agent'] = 'P4 ITS operator map/1.0';
  } else {
    headers['x-forwarded-host'] = req.headers.host;
    headers['x-forwarded-proto'] = protocol;
    headers['x-forwarded-for'] = req.socket.remoteAddress;
  }
  return headers;
}

export function createGateway(env) {
  const tls = env.NATIVE_TLS !== 'false';
  const protocol = env.PUBLIC_OPERATOR_URL ? new URL(env.PUBLIC_OPERATOR_URL).protocol.slice(0, -1) : (tls ? 'https' : 'http');
  const options = tls ? {cert: fs.readFileSync(env.NATIVE_TLS_CERT), key: fs.readFileSync(env.NATIVE_TLS_KEY)} : {};
  const server = (tls ? https : http).createServer(options, (req, res) => {
    const target = targetFor(req.url, env);
    if (target.redirect) {
      res.writeHead(308, {location: target.redirect});
      res.end();
      return;
    }
    const url = new URL(target.origin + target.path);
    const upstream = (url.protocol === 'https:' ? https : http).request(url, {
      method: req.method, headers: headersFor(req, target, protocol),
    }, response => {
      const headers = {...response.headers};
      if (target.external && headers.location?.startsWith(`${target.origin}/`)) {
        headers.location = target.prefix + headers.location.slice(target.origin.length + 1);
      }
      res.writeHead(response.statusCode, headers);
      response.pipe(res);
      response.on('error', () => res.destroy());
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, {'content-type': 'text/plain'});
      res.end('Upstream unavailable; check the native service logs.');
    });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });

  server.on('upgrade', (req, socket, head) => {
    // Expose only the two application WebSockets through this ingress.
    if (!['/ws/playback', '/api/v1/assistant/ws'].includes(req.url.split('?')[0])) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    const target = targetFor(req.url, env);
    const url = new URL(target.origin + target.path);
    const upstream = (url.protocol === 'https:' ? https : http).request(url, {
      headers: headersFor(req, target, protocol),
    });
    upstream.on('upgrade', (response, remote, remoteHead) => {
      const lines = response.rawHeaders.reduce((all, value, i, values) =>
        i % 2 ? all : [...all, `${value}: ${values[i + 1]}`], []);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`);
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      socket.pipe(remote).pipe(socket);
      remote.on('error', () => socket.destroy());
      socket.on('error', () => remote.destroy());
      socket.on('end', () => remote.destroy());
      remote.on('end', () => socket.end());
      socket.on('close', () => remote.destroy());
      remote.on('close', () => socket.destroy());
    });
    upstream.on('response', response => {
      response.resume();
      socket.end(`HTTP/1.1 ${response.statusCode} Upstream Response\r\nConnection: close\r\n\r\n`);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.end();
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createGateway(process.env);
  server.listen(Number(process.env.NATIVE_GATEWAY_PORT || 39001), process.env.NATIVE_BIND_HOST || '127.0.0.1', () => {
    console.log(`Native ingress listening on ${process.env.NATIVE_BIND_HOST || '127.0.0.1'}:${process.env.NATIVE_GATEWAY_PORT || 39001}`);
  });
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  const shutdown = () => {
    server.close();
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
