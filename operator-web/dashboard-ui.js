// Presentation labels and helpers. Backend enum values remain unchanged.
export const STATUS_LABELS = { all: '전체', running: '운행중', ready: '대기', maintenance: '점검', offline: '오프라인', stale: 'GPS 지연', unknown: '미확인' };
/** A vehicle speed with two decimal places, e.g. "42.35 km/h"; "— km/h" when unknown. */
export function formatSpeed(value) {
  const speed = value == null || String(value).trim() === '' ? Number.NaN : Number(value);
  return Number.isFinite(speed) ? `${speed.toFixed(2)} km/h` : '— km/h';
}
export const TRIP_STATUS_LABELS = { READY:'출발 대기', IN_PROGRESS:'운행 중', PAUSED:'일시정지', COMPLETED:'완료', CANCELLED:'취소' };
export const UI_LABELS = {
  'Scenario': '시나리오', 'Virtual vehicle': '가상 차량', 'not set': '미지정', 'none': '없음',
  'Vehicle': '차량', 'Source': '데이터 소스', 'Status': '상태', 'Speed': '속도', 'Observed': '관측 시각', 'Trip ID': '운행 ID',
  'Loading vehicles…': '차량 불러오는 중…', 'Select a vehicle': '차량을 선택하세요',
  'No active vehicles available': '사용 가능한 차량 없음', 'No trips created yet.': '생성된 운행이 없습니다.',
  'Choose a vehicle and destination.': '차량과 목적지를 선택하세요.',
  'Select a vehicle to load its trip recordings.': '차량을 선택하여 운행 녹화를 불러오세요.',
  'Delete segments': '구간 삭제', 'Exit delete mode': '삭제 모드 종료', 'Delete selected range': '선택 구간 삭제', 'No segments selected.': '선택한 구간이 없습니다.',
  'No pending requests.': '대기 중인 배차 요청이 없습니다.', 'Accept': '수락', 'Reject': '거절',
  'Create a scenario to begin.': '시나리오를 생성하세요.', 'Select a scenario first.': '시나리오를 먼저 선택하세요.',
  'Select a virtual vehicle and pick origin and destination.': '가상 차량과 출발지, 목적지를 선택하세요.',
  'Simulated driver request generated.': '가상 배차 요청을 생성했습니다.', 'Scenario created.': '시나리오를 생성했습니다.',
  'Choose a scenario and virtual vehicle.': '시나리오와 가상 차량을 선택하세요.',
  'No route draft.': '경로 미리보기를 실행하세요.', 'Loading source…': '데이터 소스 불러오는 중…',
};
export const uiText = text => UI_LABELS[text] || text;

/** Korean display names; codes and IDs still identify vehicles in API calls. */
export function vehicleDisplayName(item) {
  const identity=String(item?.vehicleCode??item?.externalId??item?.telemetry?.external_id??'');
  const suffix=identity.match(/(?:^|[-_:])(\d+)$/)?.[1];
  const number=String(item?.vehicleId??suffix??'').trim().replace(/^0+(?=\d)/,'');
  return number?`화물차 ${number}호`:'화물차';
}

export function applyRoadHatch(layer, kind, color) {
  layer.eachLayer(child => {
    const element = child.getElement?.(), svg = element?.ownerSVGElement;
    if (!svg) return;
    const namespace = 'http://www.w3.org/2000/svg';
    let defs = svg.querySelector('defs');
    if (!defs) { defs = document.createElementNS(namespace, 'defs'); svg.prepend(defs); }
    const id = kind === 'BLOCKED' ? 'road-blocked-hatch' : 'road-congestion-hatch';
    if (!svg.querySelector(`#${id}`)) {
      const pattern = document.createElementNS(namespace, 'pattern');
      pattern.id = id;
      for (const [name, value] of Object.entries({width:'8',height:'8',patternUnits:'userSpaceOnUse',patternTransform:'rotate(45)'})) pattern.setAttribute(name,value);
      const stripe = document.createElementNS(namespace, 'rect');
      stripe.setAttribute('width','3'); stripe.setAttribute('height','8'); stripe.setAttribute('fill',color);
      pattern.append(stripe); defs.append(pattern);
    }
    element.setAttribute('fill',`url(#${id})`); element.setAttribute('fill-opacity','0.3');
  });
}
export function vehicleStatus(item) {
  if(item?.telemetry?.source_metadata?.state==='stale')return 'stale';
  // A trip in progress means the vehicle is driving, whatever its stored
  // status says (phone-tracked vehicles keep their seeded READY).
  if(item?.tripStatus==='IN_PROGRESS')return 'running';
  const status = String(item?.vehicleStatus || item?.telemetry?.source_metadata?.state || '').toUpperCase();
  if (['DRIVING', 'IN_PROGRESS', 'ACTIVE', 'RUNNING'].includes(status)) return 'running';
  if (['READY', 'STOPPED', 'IDLE', 'AVAILABLE'].includes(status)) return 'ready';
  if (['MAINTENANCE', 'WARNING', 'INSPECTION'].includes(status)) return 'maintenance';
  if (status === 'OFFLINE') return 'offline';
  return 'unknown';
}
export function matchesVehicle(item, query) {
  const values = [vehicleDisplayName(item), item.vehicleCode, item.vehicleName, item.vehicleId, item.telemetry?.external_id];
  return values.some(value => String(value ?? '').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
}
const paths = {
  bus: '<rect x="5" y="3" width="14" height="17" rx="3"/><path d="M5 11h14M8 20v2m8-2v2M8 7h8"/><circle cx="8" cy="16" r="1"/><circle cx="16" cy="16" r="1"/>',
  map: '<path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2Zm6-2v16m6-14v16"/>',
  search: '<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/>',
  bell: '<path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5Zm5 4h4M12 2v2"/>',
  chart: '<path d="M3 3v18h18M7 17v-6m5 6V6m5 11v-8"/>',
  settings: '<circle cx="12" cy="12" r="4"/><path d="m9 3 1-2h4l1 2 3 2 2 1 2 4-2 2v3l-1 3-3 1-2 3h-4l-2-3-3-1-2-3v-3l-2-2 2-4 2-1Z"/>',
  video: '<rect x="2" y="5" width="13" height="14" rx="2"/><path d="m15 9 7-4v14l-7-4"/>',
  route: '<circle cx="5" cy="5" r="2"/><circle cx="19" cy="19" r="2"/><path d="M7 5h9a4 4 0 0 1 0 8H8a3 3 0 0 0 0 6h9"/>',
  play: '<path d="m7 3 14 9-14 9Z"/>',
  pause: '<path d="M8 3v18M16 3v18"/>',
  pin: '<path d="M19 9c0 5-7 12-7 12S5 14 5 9a7 7 0 1 1 14 0Z"/><circle cx="12" cy="9" r="2"/>',
  time: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 3"/>',
  fullscreen: '<path d="M3 9V3h6m6 0h6v6m0 6v6h-6m-6 0H3v-6"/>',
  warning: '<path d="m12 3 10 18H2Zm0 6v5m0 3v1"/>',
  assistant: '<path d="M4 5h16v11H9l-5 4Z"/><path d="M8 9h8M8 12h5"/>'
};
export const icon = name => `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.bus}</svg>`;
export function vehicleIcon(item, selected = false, virtual = false, livePreview = false) {
  const color = livePreview ? '#ff8a3d' : '#2563eb';
  const vehicle = '<svg class="transport-vehicle" viewBox="0 0 32 32" aria-hidden="true"><path d="M9 5h14a4 4 0 0 1 4 4v14a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V9a4 4 0 0 1 4-4Z" fill="white"/><rect x="8" y="9" width="16" height="9" rx="2" fill="var(--vehicle-color)"/><path d="M16 10v7" stroke="white" stroke-width="1.5"/><rect x="7" y="25" width="5" height="4" rx="1.5" fill="white"/><rect x="20" y="25" width="5" height="4" rx="1.5" fill="white"/><circle cx="10" cy="22" r="1.8" fill="var(--vehicle-color)"/><circle cx="22" cy="22" r="1.8" fill="var(--vehicle-color)"/><path d="M14 23h4" stroke="var(--vehicle-color)" stroke-width="2" stroke-linecap="round"/></svg>';
  return L.divIcon({className:'vehicle-map-icon',html:`<span class="transport-marker${selected ? ' selected' : ''}${livePreview ? ' live-preview' : ''}" style="--vehicle-color:${color}" aria-label="${livePreview ? '실시간 영상 차량' : virtual ? '가상 차량' : '차량'}"><span class="transport-disc">${vehicle}</span>${livePreview ? `<span class="vehicle-camera-badge">${icon('video')}</span>` : ''}</span>`,iconSize:[44,44],iconAnchor:[22,22],tooltipAnchor:[0,-28]});
}
export function renderVehicleDetails(item) {
  const t = item.telemetry || {}, state = vehicleStatus(item);
  const write = (id, text) => { document.getElementById(id).textContent = text; };
  document.querySelector('#selection-empty').hidden = true;
  write('selected-source', [vehicleDisplayName(item), item.vehicleSource,t.telemetry_source==='RECORDED_GPS'?null:t.telemetry_source].filter(Boolean).join(' · '));
  write('selected-speed', formatSpeed(t.speed_kmh));
  write('selected-state', TRIP_STATUS_LABELS[item.tripStatus]||STATUS_LABELS[state]); write('selected-trip', item.tripId ?? '—');
  const observed = new Date(t.source_metadata?.receivedAt ?? t.observed_at_utc);
  write('selected-updated', `최근 업데이트 ${Number.isNaN(observed.getTime()) ? '미확인' : observed.toLocaleTimeString('ko-KR', {hour12:false})}`);
  write('selected-status', STATUS_LABELS[state]);
  document.querySelector('#selected-status').className = `ui-chip ui-chip--${state === 'running' || state === 'ready' ? 'success' : state === 'maintenance' ? 'danger' : 'neutral'}`;
}

export function vehicleDetailRows(item) {
  const t = item.telemetry || {};
  const rows = [[uiText('Vehicle'),vehicleDisplayName(item)],[uiText('Source'),[item.vehicleSource,t.telemetry_source].filter(Boolean).join(' / ')],
    [uiText('Status'),TRIP_STATUS_LABELS[item.tripStatus]||STATUS_LABELS[vehicleStatus(item)]],[uiText('Speed'),formatSpeed(t.speed_kmh)],
    ['최근 수신 시각',t.source_metadata?.receivedAt??t.observed_at_utc??'—'],[uiText('Trip ID'),item.tripId??'—']];
  if(t.telemetry_source==='RECORDED_GPS')rows.push(['원본 녹화 시각',t.observed_at_utc??'—']);
  return rows;
}
export function initializeDashboard({ map, markers, selectVehicle, showFleet }) {
  let fleet = [], filter = 'all', query = '', drawerOpen = false;
  const filters = document.querySelector('#fleet-filters'), results = document.querySelector('#fleet-results');
  const search = document.querySelector('#fleet-search'), drawer = document.querySelector('#fleet-drawer');
  document.querySelectorAll('[data-icon]').forEach(el => el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon)));
  function updateVisibility() {
    for (const entry of markers.values()) {
      const visible = !window.__virtualMode && (filter === 'all' || vehicleStatus(entry.item) === filter) && matchesVehicle(entry.item, query);
      if (visible) entry.marker.addTo(map); else map.removeLayer(entry.marker);
    }
  }
  function render() {
    const counts = Object.fromEntries(Object.keys(STATUS_LABELS).map(key => [key, 0]));
    counts.all = fleet.length;
    fleet.forEach(item => counts[vehicleStatus(item)]++);
    filters.replaceChildren();
    for (const [key,label] of Object.entries(STATUS_LABELS)) {
      if (key === 'unknown' && !counts[key]) continue;
      const button = document.createElement('button'); button.type = 'button';
      button.textContent = `${label} (${counts[key]})`; button.setAttribute('aria-pressed', String(filter === key));
      button.onclick = () => { filter = key; render(); }; filters.append(button);
    }
    const legend = document.querySelector('#fleet-legend'); legend.replaceChildren();
    for (const [key,label] of Object.entries(STATUS_LABELS)) {
      if (key === 'all' || !counts[key]) continue;
      const row = document.createElement('span'), dot = document.createElement('i'); dot.className = `legend-dot ${key}`;
      row.append(dot, `${label} ${counts[key]}`); legend.append(row);
    }
    if (!fleet.length) legend.textContent = '차량 데이터 대기 중';
    results.replaceChildren();
    const matches = fleet.filter(item => (filter === 'all' || vehicleStatus(item) === filter) && matchesVehicle(item, query));
    for (const item of matches.slice(0,100)) {
      const li = document.createElement('li'), button = document.createElement('button'); button.type = 'button';
      button.textContent = `${vehicleDisplayName(item)} · ${STATUS_LABELS[vehicleStatus(item)]}`;
      button.onclick = () => { selectVehicle(item); const t=item.telemetry; if(Number.isFinite(t.latitude)&&Number.isFinite(t.longitude))map.setView([t.latitude,t.longitude],Math.max(15,map.getZoom())); drawerOpen=false;query='';search.value='';render(); };
      li.append(button); results.append(li);
    }
    if (!matches.length) { const li=document.createElement('li');li.textContent='일치하는 차량이 없습니다.';results.append(li); }
    drawer.hidden = !(drawerOpen || query);
    updateVisibility();
  }
  search.addEventListener('input', () => { query = search.value; render(); });
  document.querySelector('#show-fleet').onclick=()=>{filter='all';query='';search.value='';render();showFleet(fleet);};
  search.addEventListener('keydown', e => { if(e.key==='Escape'){query='';search.value='';drawerOpen=false;render();} });
  document.querySelectorAll('[data-rail]').forEach(button => button.onclick = () => {
    const view=button.dataset.rail;
    document.querySelectorAll('[data-rail]').forEach(el=>el.setAttribute('aria-pressed',String(el===button)));
    document.querySelector('#settings-drawer').hidden=view!=='settings'; drawerOpen=view==='fleet'; render();
    const assistant=document.querySelector('#assistant-drawer'); if(assistant)assistant.hidden=view!=='assistant';
    if(view==='fleet')search.focus();
    if(view==='assistant')document.querySelector('#assistant-question')?.focus();
  });
  document.querySelector('#close-settings').onclick=()=>document.querySelector('[data-rail=map]').click();
  const clock=()=>{ const now=new Date();const el=document.querySelector('#local-clock');el.dateTime=now.toISOString();el.textContent=now.toLocaleString('ko-KR',{month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hour12:false}); };
  clock();setInterval(clock,1000);
  for(const name of ['live','saved'])document.querySelector(`#recording-${name}-tab`).onclick=()=>{
    for(const tab of ['live','saved']){document.querySelector(`#recording-${tab}-content`).hidden=tab!==name;document.querySelector(`#recording-${tab}-tab`).setAttribute('aria-pressed',String(tab===name));}
    if(name==='live')document.querySelector('#recording-player').pause();
  };
  const player=document.querySelector('#recording-player'),speed=document.querySelector('#recording-speed');
  speed.onchange=()=>{player.playbackRate=Number(speed.value);};player.addEventListener('loadedmetadata',()=>{player.playbackRate=Number(speed.value);});
  const login=document.querySelector('#login');
  // Keep keyboard focus inside the blocking sign-in card while it is visible.
  login.addEventListener('keydown',e=>{if(e.key!=='Tab')return;const controls=[...login.querySelectorAll('input,button')];const first=controls[0],last=controls.at(-1);if(e.shiftKey&&document.activeElement===first){last.focus();e.preventDefault();}else if(!e.shiftKey&&document.activeElement===last){first.focus();e.preventDefault();}});
  const syncLogin=()=>{if(!login.hidden&&!window.__virtualMode)login.querySelector('input').focus();};
  new MutationObserver(syncLogin).observe(login,{attributes:true,attributeFilter:['hidden']});syncLogin();
  render();
  return { update(items){fleet=items;render();}, updateVisibility };
}
