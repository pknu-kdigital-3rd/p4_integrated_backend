// Real file:// review smoke test, using Chrome's DevTools protocol and Node 24.
// Usage: node tests/browser-review-smoke.cjs <generated-bundle-directory>
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');

async function main() {
  const bundle = path.resolve(process.argv[2]);
  const executable = process.env.CHROME_EXECUTABLE || (process.platform === 'win32'
    ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : 'google-chrome');
  const parent = fs.realpathSync(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(parent, 'vision-review-browser-'));
  const chrome = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let socket;
  const errors = [], requests = [];
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(check, message) {
    for (let i = 0; i < 150; i++) { const result = await check(); if (result) return result; await delay(100); }
    throw new Error(message);
  }
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    await until(() => fs.existsSync(portFile), 'Chrome did not start');
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let sequence = 0;
    const pending = new Map();
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const callback = pending.get(message.id); pending.delete(message.id);
        if (message.error) callback.reject(new Error(message.error.message)); else callback.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text + ': ' + message.params.exceptionDetails.exception?.description);
      else if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url);
    };
    function send(method, params = {}) {
      const id = ++sequence;
      return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
    }
    async function evaluate(expression) {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    }
    await send('Runtime.enable'); await send('Network.enable'); await send('Page.enable');
    await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await send('Page.navigate', { url: pathToFileURL(path.join(bundle, 'review.html')).href });
    await until(() => evaluate("typeof InferenceReview === 'object'"), 'Portable scripts did not load');
    const document = await send('DOM.getDocument');
    for (const [selector, file] of [['#video-file', 'playback.mp4'], ['#manifest-file', 'manifest.json'], ['#results-file', 'inference.jsonl']]) {
      const { nodeId } = await send('DOM.querySelector', { nodeId: document.root.nodeId, selector });
      await send('DOM.setFileInputFiles', { nodeId, files: [path.join(bundle, file)] });
    }
    await evaluate("document.getElementById('load').click()");
    await until(() => evaluate("!document.getElementById('controls').disabled && document.getElementById('position').textContent.includes('frame 1/')"),
      'Bundle did not load: ' + await evaluate("document.getElementById('status').textContent"));
    await evaluate("document.getElementById('next').click()");
    await until(() => evaluate("document.getElementById('position').textContent.includes('frame 2/')"), 'Next-frame step failed');
    await evaluate("document.getElementById('previous').click()");
    await until(() => evaluate("document.getElementById('position').textContent.includes('frame 1/')"), 'Previous-frame step failed');
    await evaluate("document.getElementById('timeline').value = 0.1; document.getElementById('timeline').dispatchEvent(new Event('change'))");
    await until(() => evaluate("document.getElementById('position').textContent.includes('0.100')"), 'Variable-rate seek failed');
    await evaluate("for (const id of ['boxes','masks','distances','distance-colors']) { const el=document.getElementById(id); el.checked=false; el.dispatchEvent(new Event('input')); }");
    await evaluate("document.getElementById('loop-start').value=0; document.getElementById('loop-end').value=0.08; document.getElementById('loop').click(); document.getElementById('play').click()");
    await delay(600);
    assert.equal(await evaluate("document.getElementById('decoder').paused"), false);
    assert.ok(await evaluate("document.getElementById('decoder').currentTime < 0.15"), 'Loop did not rewind');
    await evaluate("document.getElementById('clear-loop').click()");
    await until(() => evaluate("document.getElementById('decoder').ended"), 'Playback did not finish');
    assert.equal(errors.length, 0, errors.join('\n'));
    assert.ok(!requests.some(url => /^https?:/.test(url)), requests.join('\n'));
    console.log('Portable file:// review passed offline: load, frame stepping, variable-rate seek, overlay controls, loops and end-of-video.');
  } finally {
    socket?.close(); chrome.kill();
    await new Promise(resolve => { if (chrome.exitCode !== null) resolve(); else chrome.once('exit', resolve); });
    // Delete only this test's freshly created profile under the known temp root.
    if (path.dirname(fs.realpathSync(profile)) !== parent) throw new Error('Unexpected test profile path');
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
