'use strict';
const $ = id => document.getElementById(id);
let busy = false, selected = null;
function setBusy(value) { busy = value; $('refresh').disabled = value; document.querySelectorAll('button.danger').forEach(button => { button.disabled = value; }); }
function message(text, error = false) {
  $('message').textContent = text;
  $('message').className = error ? 'error' : '';
}
function node(tag, text) { const el = document.createElement(tag); el.textContent = text; return el; }
function render(data) {
  const peer = data.relay?.peer;
  const connectionLabel = data.relay ? '연결 없음' : '확인 불가';
  const values = [ ['연결 상태', peer?.connectionState ?? connectionLabel], ['ICE 상태', peer?.iceConnectionState ?? '—'], ['ICE 수집', peer?.iceGatheringState ?? '—'], ['신호 상태', peer?.signalingState ?? '—'] ];
  $('peer').replaceChildren(...values.map(([title, value]) => { const el = node('div', ''); el.className = 'metric'; el.append(node('span', title), node('strong', value)); return el; }));
  $('candidates').textContent = peer ? JSON.stringify({local: peer.localCandidate ?? null, remote: peer.remoteCandidate ?? null}, null, 2) : (data.relay ? '연결된 ICE 후보가 없습니다.' : '릴레이 상태를 확인할 수 없습니다.');
  $('count').textContent = `${data.sessions.length}개 할당`;
  $('sessions').replaceChildren(...data.sessions.map(session => {
    const row = document.createElement('tr');
    const identity = node('td', session.id); identity.append(node('small', session.username));
    const relay = node('td', session.relays.join('\n') || '—');
    const client = node('td', session.client ?? '—');
    const protocol = node('td', `${session.clientProtocol ?? '—'} → ${session.relayProtocol ?? '—'}`);
    const age = node('td', `${session.ageSeconds ?? '—'}초 유지`); age.append(node('small', `${session.expiresSeconds ?? '—'}초 후 만료`));
    const traffic = node('td', session.usage ?? '—'); traffic.append(node('small', session.rate ?? '—'));
    const control = document.createElement('td'), button = node('button', '연결 해제'); button.className = 'danger'; button.disabled = busy;
    button.addEventListener('click', () => { selected = session.id; $('release-label').textContent = `${session.id} · ${session.client ?? '—'} · ${session.relays.join(', ')}`; $('confirmation').showModal(); });
    control.append(button); row.append(identity, relay, client, protocol, age, traffic, control); return row;
  }));
  if (!data.sessions.length) { const row = document.createElement('tr'), cell = node('td', data.errors.length ? '할당 정보를 확인할 수 없습니다.' : '할당된 연결이 없습니다.'); cell.colSpan = 7; row.append(cell); $('sessions').append(row); }
  message(data.errors.length ? data.errors.join(' · ') : '실제 서버 상태를 확인했습니다.', !!data.errors.length);
  $('updated').textContent = `확인: ${new Date().toLocaleTimeString()}`;
}
async function request(url, options) {
  const response = await fetch(url, {cache:'no-store', ...options});
  if (response.status === 401) throw new Error('관리자 인증이 필요합니다. 페이지를 다시 여세요.');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
async function refresh() {
  if (busy) return;
  setBusy(true);
  try { render(await request('/api/status')); }
  catch (error) { message(error.message, true); }
  finally { setBusy(false); }
}
$('refresh').addEventListener('click', refresh);
$('confirmation').addEventListener('close', async () => {
  if ($('confirmation').returnValue !== 'release' || !selected || busy) return;
  setBusy(true);
  const id = selected; selected = null;
  try {
    await request('/api/release', {method:'POST', headers:{'Content-Type':'application/json', 'X-Turn-Control':'release'}, body:JSON.stringify({sessionId:id})});
    render(await request('/api/status')); message(`세션 ${id}의 할당이 해제되었습니다.`);
  } catch (error) { message(error.message, true); }
  finally { setBusy(false); }
});
setInterval(() => { if ($('auto').checked && !document.hidden && !$('confirmation').open) refresh(); }, 2000);
refresh();
