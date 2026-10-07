import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {test} from 'node:test';
import {createGateway, targetFor} from '../native-gateway.mjs';

const listen = async server => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
};

test('native ingress routes dashboard, preview, map tiles and WebSockets', async t => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({url: req.url, headers: req.headers});
    req.pipe(res);
  });
  const address = await listen(upstream);
  const env = {NATIVE_TLS: 'false', NATIVE_NODE_URL: address, NATIVE_ROUTING_URL: address, NATIVE_VISION_URL: address};
  const gateway = createGateway(env);
  const origin = await listen(gateway);
  t.after(() => { gateway.closeAllConnections(); gateway.close(); upstream.closeAllConnections(); upstream.close(); });

  for (const [path, expected] of [['/operator/app.js', '/operator/app.js'], ['/live/?embedded=1', '/?embedded=1'],
    ['/live/live-view-tracks.js', '/live-view-tracks.js'], ['/health/vision', '/health/live']]) {
    const response = await fetch(origin + path, {method: 'POST', body: 'frame-body'});
    assert.equal(await response.text(), 'frame-body');
    assert.equal(seen.at(-1).url, expected);
    assert.equal(seen.at(-1).headers['x-forwarded-host'], new URL(origin).host);
    assert.equal(seen.at(-1).headers['x-forwarded-proto'], 'http');
  }
  const redirect = await fetch(origin + '/live', {redirect: 'manual'});
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), '/live/');
  assert.equal(targetFor('/basemap/styles/liberty', env).origin, 'https://tiles.openfreemap.org');
  assert.equal(targetFor('/basemap/styles/liberty', env).path, '/styles/liberty');
  // A double slash in a client-controlled path must not select another host.
  await fetch(origin + '/live//example.invalid/secret');
  assert.equal(seen.at(-1).url, '//example.invalid/secret');

  upstream.on('upgrade', (req, socket, head) => {
    seen.push({url: req.url, headers: req.headers});
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    if (head.length) socket.write(head);
    socket.on('data', data => socket.write(data));
  });
  for (const path of ['/ws/playback?epoch=2', '/api/v1/assistant/ws']) {
    const socket = net.connect(new URL(origin).port, '127.0.0.1');
    await once(socket, 'connect');
    let received = Buffer.alloc(0);
    const payload = Buffer.from([0, 255, 128, 13, 10, 0, 42]);
    const complete = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Upgrade/stream timed out')), 3000);
      socket.on('error', reject);
      socket.on('data', data => {
        received = Buffer.concat([received, data]);
        const end = received.indexOf('\r\n\r\n');
        if (end >= 0 && received.length >= end + 4 + payload.length) {
          clearTimeout(timeout);
          resolve(end);
        }
      });
    });
    socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
    socket.write(payload);
    const end = await complete;
    assert.match(received.subarray(0, end).toString(), /^HTTP\/1.1 101/);
    assert.deepEqual(received.subarray(end + 4), payload);
    assert.equal(seen.at(-1).url, path);
    const closed = once(socket, 'close');
    socket.destroy();
    await closed;
  }
});

test('an unavailable service returns a useful 502', async t => {
  const unused = http.createServer();
  const address = await listen(unused);
  await new Promise(resolve => unused.close(resolve));
  const gateway = createGateway({NATIVE_TLS: 'false', NATIVE_NODE_URL: address});
  const origin = await listen(gateway);
  t.after(() => {gateway.closeAllConnections(); gateway.close();});
  const response = await fetch(origin + '/operator/');
  assert.equal(response.status, 502);
  assert.match(await response.text(), /Upstream unavailable/);
});

test('generated HTTPS certificate is trusted explicitly and public tunnel scheme reaches the backend', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-native-tls-'));
  t.after(() => fs.rmSync(folder, {recursive: true, force: true}));
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const env = {NATIVE_TLS: 'true', PUBLIC_OPERATOR_URL: 'https://localhost:39001',
    JWT_PRIVATE_KEY_PATH: path.join(folder, 'jwt-private.pem'), JWT_PUBLIC_KEY_PATH: path.join(folder, 'jwt-public.pem'),
    NATIVE_TLS_CERT: path.join(folder, 'server.crt'), NATIVE_TLS_KEY: path.join(folder, 'server.key')};
  const python = process.env.NATIVE_TEST_PYTHON || path.join(root, 'services/vision/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  execFileSync(python, [path.join(root, 'scripts/native-keys.py')], {env: {...process.env, ...env}});
  const firstKey = fs.readFileSync(env.JWT_PRIVATE_KEY_PATH);
  execFileSync(python, [path.join(root, 'scripts/native-keys.py')], {env: {...process.env, ...env}});
  assert.deepEqual(fs.readFileSync(env.JWT_PRIVATE_KEY_PATH), firstKey);
  const upstream = http.createServer((req, res) => res.end(req.headers['x-forwarded-proto']));
  env.NATIVE_NODE_URL = await listen(upstream);
  const gateway = createGateway(env);
  await listen(gateway);
  t.after(() => {gateway.closeAllConnections(); gateway.close(); upstream.closeAllConnections(); upstream.close();});
  const received = await new Promise((resolve, reject) => {
    https.get(`https://127.0.0.1:${gateway.address().port}/operator/`, {ca: fs.readFileSync(env.NATIVE_TLS_CERT)}, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
  assert.equal(received, 'https');
  const httpGateway = createGateway({...env, NATIVE_TLS: 'false'});
  const httpOrigin = await listen(httpGateway);
  t.after(() => {httpGateway.closeAllConnections(); httpGateway.close();});
  assert.equal(await (await fetch(httpOrigin + '/operator/')).text(), 'https');
});
