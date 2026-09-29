import {uiText, initializeDashboard, renderVehicleDetails, vehicleIcon, TRIP_STATUS_LABELS} from './dashboard-ui.js';
import {fleetPosition, createFleetViewport} from './fleet-view.js';
import {buildReplayTimeline,detectionSampleAtPts,entryForTime} from './replay-timeline.js';
import {acceptLiveTelemetry,applyLiveTelemetry,createLiveView,describeLiveTelemetry,isLiveOverride} from './live-telemetry.js';
import {createAndroidMarkerRevealer,createLiveMapFollower,fleetMarkerStyle,isAndroidGpsItem,LIVE_MARKER_STYLE} from './live-map.js';
import {FOREGROUND_RESUME_MESSAGE,installForegroundResume} from './foreground-resume.js';
import {plannedProgress,recordedProgress,replayProgressOnRoute,tripTimes} from './trip-route-ui.js';
import {installPanelDrag} from './panel-drag.js';
import {describeDetections} from './detection-status.js';
const map=L.map('map').setView([35.1796,129.0756],12);
window.__operatorMap=map;
const fleetViewport=createFleetViewport(map);
L.tileLayer('/osm/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap contributors'}).addTo(map);
const markers=new Map(),tripMapMarkers=new Map();let token=sessionStorage.getItem('itsToken');let bootstrap;let selected;let routeLayer;let replayRouteLayer;let destinationMarker;let displayedRouteKey='';let displayRequest=0;let latestFleet=[];let assignmentPreview=null;let assignmentPreviewVehicleId='';let assignmentPreviewLayer=null;let activeTripByVehicle=new Map();let assignmentPreviewKey='';let demoMode=false;let currentRole='';let recordingsRequest=0;let refreshTimer;let telemetryModeTimer;let tripMapPick;let replayTimeline=[];let replayDuration=0;let replayIndex=-1;let replayGeneration=0;let replayTripId='';let recordingDeleteRange=null;let recordingDeleteDrag=null;let replayScrubbing=false;let replayScrubWasPlaying=false;let replaySeekGeneration=0;let replaySeekPending=false;let liveView=null;let lastLiveMessage=null;let liveStatusTimer;
const error=document.querySelector('#error'),details=document.querySelector('#details'),fields=document.querySelector('#fields');
const operatorLayout=document.querySelector('#operator-layout');
const livePanel=document.querySelector('#live-view-panel'),liveFrame=document.querySelector('#live-view-frame'),liveRecenterButton=document.querySelector('#live-recenter');
// Debugging details (diagnostics, telemetry status, the Vision page's controls)
// are hidden by default and one click away; the choice is remembered.
let liveDetailsHidden=(()=>{try{return localStorage.getItem('operatorLiveDetailsHidden')!=='false'}catch{return true}})();
function syncLiveDetails(){
  livePanel.classList.toggle('details-hidden',liveDetailsHidden);
  const button=document.querySelector('#live-details');
  button.textContent=liveDetailsHidden?'상세 보기':'상세 숨기기';
  button.setAttribute('aria-pressed',String(!liveDetailsHidden));
  notifyLiveFrameFullscreen();
  fitLivePanelToVideo();
}
// In video-only mode the panel takes the video's exact shape, so there are no
// black bars; it stays at most 540px wide and inside the map. With details
// shown (or before the video size is known) the stylesheet size applies.
let liveVideoSize=null;
const LIVE_PANEL_INSET=8; // matches the video's side margins in styles.css
const LIVE_PANEL_FOOTER=30; // the detection status row under the video
function fitLivePanelToVideo(){
  const fit=liveDetailsHidden&&liveVideoSize&&!livePanel.hidden&&document.fullscreenElement!==livePanel;
  if(!fit){livePanel.style.removeProperty('width');livePanel.style.removeProperty('height')}
  else{
    const surface=document.querySelector('#map-surface').getBoundingClientRect(),header=48,inset=LIVE_PANEL_INSET,footer=LIVE_PANEL_FOOTER;
    const ratio=liveVideoSize.width/liveVideoSize.height;
    let videoWidth=Math.max(160,Math.min(540,surface.width-36))-2*inset,videoHeight=videoWidth/ratio;
    const maxVideoHeight=Math.max(90,Math.min(470,surface.height-36,surface.height*0.7)-header-footer);
    if(videoHeight>maxVideoHeight){videoHeight=maxVideoHeight;videoWidth=videoHeight*ratio}
    livePanel.style.width=`${Math.round(videoWidth+2*inset)}px`;livePanel.style.height=`${Math.round(header+videoHeight+footer)}px`;
  }
  livePanelDrag?.apply();
}
document.querySelector('#live-details').addEventListener('click',()=>{
  liveDetailsHidden=!liveDetailsHidden;
  try{localStorage.setItem('operatorLiveDetailsHidden',String(liveDetailsHidden))}catch{}
  syncLiveDetails();
});
// Drag the live preview by its title bar anywhere inside the map.
const livePanelDrag=installPanelDrag({panel:livePanel,handle:livePanel.querySelector('.live-view-header'),container:document.querySelector('#map-surface'),storage:(()=>{try{return localStorage}catch{return null}})(),storageKey:'operatorLivePanelPosition'});
// Declared above the drag helper it calls, so it runs only once that exists.
syncLiveDetails();
new ResizeObserver(()=>fitLivePanelToVideo()).observe(document.querySelector('#map-surface'));
function createMarkerEntry(item,position,{liveOnly=false}={}){
  const androidGps=isAndroidGpsItem(item),marker=L.marker(position,{icon:vehicleIcon(item,liveOnly),zIndexOffset:liveOnly?1000:0}).addTo(map);
  const entry={marker,item,liveOnly};
  marker.on('click',()=>selectVehicle(entry.item));
  const label=document.createElement('span');label.textContent=item?.telemetry?.telemetry_source==='RECORDED_GPS'?`Android GPS 재생 · ${item?.vehicleCode||'vehicle'}`:androidGps?`Android GPS · ${item?.vehicleCode||item?.telemetry?.external_id||'vehicle'}`:item?.vehicleCode||item?.telemetry?.external_id||'Live vehicle';marker.bindTooltip(label,{direction:'top',className:'vehicle-label'});
  if(item?.telemetry?.external_id)markers.set(item.telemetry.external_id,entry);
  return entry;
}
// Every normal-monitoring layer on the map. All three are cached and only
// added to the map when first created, so whoever takes the map away has to
// put them back: render() reuses a cached marker rather than recreating it, so
// a detached marker would never reappear for the rest of the session.
function normalMapLayers(){
  return [...markers.values()].map(entry=>entry.marker)
    .concat([...tripMapMarkers.values()],[routeLayer,replayRouteLayer,destinationMarker,assignmentPreviewLayer].filter(Boolean));
}
// Used by the virtual workspace, which takes the map over while it is open.
window.__operatorDetachMapLayers=()=>{fleetViewport.save();for(const layer of normalMapLayers())map.removeLayer(layer)};
window.__operatorAttachMapLayers=()=>{for(const layer of normalMapLayers())layer.addTo(map);dashboard.updateVisibility();fleetViewport.restore()};
const liveMapFollower=createLiveMapFollower({
  map,markers,
  createEntry:(item,position)=>createMarkerEntry(item,position,{liveOnly:true}),
  onFollowingChange:following=>{liveRecenterButton.hidden=following;liveRecenterButton.setAttribute('aria-pressed',String(following))},
});
const revealAndroidMarker=createAndroidMarkerRevealer({map});
map.on('dragstart',()=>liveMapFollower.pause());
function refreshMapLayout(){requestAnimationFrame(()=>map.invalidateSize({pan:false}));}
new ResizeObserver(refreshMapLayout).observe(document.querySelector('#map-surface'));
const dashboard=initializeDashboard({map,markers,selectVehicle,showFleet:items=>fleetViewport.fit(items)});
async function api(path,options={},raw=false){const requestPath=demoMode&&!raw?path.replace('/api/v1/','/api/v1/demo/'):path;const response=await fetch(requestPath,{...options,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})}});if(!response.ok)throw new Error((await response.json().catch(()=>({}))).error?.message||`HTTP ${response.status}`);return (await response.json()).data}
// Live View follows a stream, not a trip, so the trip is not part of the target.
function sameLiveTarget(liveTarget,item){return liveTarget?.markerKey===(item?.telemetry?.external_id??null)&&liveTarget?.vehicleId===(item?.vehicleId!=null?String(item.vehicleId):null)}
// Any vehicle whose phone is streaming can be watched; a running trip only
// decides whether the relay also records it.
function matchesLiveTarget(item){
  const metadata=item?.telemetry?.source_metadata||{};
  return item?.vehicleId!=null
    &&String(metadata.vehicleId??'')===String(item.vehicleId)
    &&typeof metadata.recordingSessionId==='string'&&metadata.recordingSessionId.length>0;
}
function syncLiveViewButton(item=selected){
  const button=document.querySelector('#live-view');
  button.disabled=!bootstrap||!matchesLiveTarget(item);
  button.title=button.disabled?"Live View is available while this vehicle's phone is streaming.":'';
}
function releaseLiveMarker(){
  const markerState=liveMapFollower.end();
  if(!markerState.markerKey)return;
  const entry=markers.get(markerState.markerKey);
  if(entry?.liveOnly){map.removeLayer(entry.marker);markers.delete(markerState.markerKey)}
  else if(entry){
    const telemetry=entry.item?.telemetry;
    if(Number.isFinite(telemetry?.latitude)&&Number.isFinite(telemetry?.longitude))entry.marker.setLatLng([telemetry.latitude,telemetry.longitude]);
  }
}
function liveTargetLabel(item){return item?.vehicleCode||item?.vehicleName||`Vehicle ID ${item?.vehicleId??item?.telemetry?.external_id??'unknown'}`}
// The Vision page's "fullscreen" mode shows only the video, scaled to fit the
// frame; it is also used while the debugging details are hidden.
function notifyLiveFrameFullscreen(fullscreen=document.fullscreenElement===livePanel||liveDetailsHidden){
  if(!liveView)return;
  liveFrame.contentWindow?.postMessage({type:'operator-live-view-fullscreen',fullscreen},liveView.frameOrigin);
}
function retargetLiveView(item){
  if(!liveView||sameLiveTarget(liveView,item))return;
  // The video belongs to the vehicle it was opened for; selecting another
  // vehicle closes it instead of relabelling that stream.
  if(liveView.markerKey!==(item?.telemetry?.external_id??null)){stopLiveView();return}
  const frameOrigin=liveView.frameOrigin;
  releaseLiveMarker();
  liveView=createLiveView(item,frameOrigin);
  lastLiveMessage=null;
  liveMapFollower.begin(liveView);
  document.querySelector('#live-view-title').textContent=`실시간 영상 · ${liveTargetLabel(item)}`;
  renderLiveTelemetryStatus();
}
function clearTripLayers(){
  for(const layer of [routeLayer,replayRouteLayer,destinationMarker])if(layer)map.removeLayer(layer);
  routeLayer=null;replayRouteLayer=null;destinationMarker=null;displayedRouteKey='';
}
function showTripDisplay(display){
  const card=document.querySelector('#trip-progress-card');card.hidden=false;
  document.querySelector('#selected-origin').textContent=display.originName||'배정 시점의 차량 위치';
  document.querySelector('#selected-destination').textContent=display.destinationName;
  const times=tripTimes(display);
  document.querySelector('#selected-origin-time').textContent=times.origin;
  document.querySelector('#selected-destination-time').textContent=times.destination;
  const replayOnly=display.routeMode==='REPLAY_ONLY';
  document.querySelector('#selected-route-mode').textContent=`${replayOnly?'Android GPS 재생 경로':'최적 경로 + Android GPS 재생'} · ${TRIP_STATUS_LABELS[display.tripStatus]||display.tripStatus}`;
  const key=`${display.tripId}:${display.routeMode}:${display.plannedRoute?.routeId??''}:${display.replayPreview?.fingerprint??''}`;
  if(key!==displayedRouteKey){
    clearTripLayers();displayedRouteKey=key;
    if(!replayOnly&&display.plannedRoute?.routeGeojson)routeLayer=L.geoJSON(display.plannedRoute.routeGeojson,{style:{color:'#0868dd',weight:6}}).addTo(map);
    const points=display.replayPreview?.points;
    if(Array.isArray(points)&&points.length>1){
      replayRouteLayer=L.polyline(points.map(point=>[point[2],point[1]]),{color:'#e78328',weight:4,dashArray:replayOnly?undefined:'10 8'}).addTo(map);
      replayRouteLayer.bindTooltip('Android GPS 재생 경로');
    }
    const target=replayOnly?points?.at(-1)?.slice(1,3):display.plannedRoute?.routeGeojson?.coordinates?.at(-1);
    if(target)destinationMarker=L.circleMarker([target[1],target[0]],{radius:8,color:'#fff',weight:2,fillColor:'#e53955',fillOpacity:1}).addTo(map).bindTooltip(display.destinationName);
  }
  document.querySelector('#route-label').textContent=replayOnly?'Android GPS 재생 경로':`최적 경로${display.replayPreview?' + Android GPS 재생 경로':''}`;
  let progress=null,label='진행 상태 대기 중';
  if(replayOnly){
    progress=recordedProgress(display.replayPreview,display.replayPosition?.sourceTimestampNs);
    const replayFix=latestFleet.find(item=>String(item.vehicleId)===String(display.vehicleId)&&item.telemetry?.telemetry_source==='RECORDED_GPS')?.telemetry;
    document.querySelector('#selected-current').textContent=replayFix?`GPS 재생 위치 · ${replayFix.latitude.toFixed(5)}, ${replayFix.longitude.toFixed(5)}`:'GPS 재생 위치 대기 중';
    label=progress?`GPS 재생 ${progress.percent}% · 남은 기록 경로 ${(progress.remainingM/1000).toFixed(1)} km`:'GPS 재생 대기 중 · 실제 운행 진행률 아님';
  }else{
    const live=latestFleet.find(item=>String(item.vehicleId)===String(display.vehicleId)&&item.telemetry?.telemetry_source==='BIMS_LIVE'&&item.telemetry?.source_metadata?.state==='live')
      ||latestFleet.find(item=>String(item.vehicleId)===String(display.vehicleId)&&item.telemetry?.telemetry_source==='DEVICE_GPS');
    const fix=live?.telemetry,age=Date.now()-new Date(fix?.observed_at_utc??'').getTime();
    document.querySelector('#selected-current').textContent=fix&&age>=0&&age<=60000?`실제 GPS 위치 · ${fix.latitude.toFixed(5)}, ${fix.longitude.toFixed(5)}`:'실제 GPS 위치 대기 중';
    if(fix&&age>=0&&age<=60000){
      progress=plannedProgress(display.plannedRoute?.routeGeojson,fix);
      if(progress?.offRouteM>100){label=`실제 GPS가 계획 경로에서 ${progress.offRouteM} m 벗어남`;progress=null}
      else if(progress)label=`실제 GPS ${progress.percent}% · 남은 계획 경로 ${(progress.remainingM/1000).toFixed(1)} km`;
    }else{
      // Without a real fix, place the Android replay's current position on the
      // operator's planned route, so the percentage, the destination and the
      // arrival time all describe the same route. The replay path may differ
      // from that route, so the distance from it is shown rather than hidden.
      // It is labelled as replay, never as real trip progress.
      const replayFix=latestFleet.find(item=>String(item.vehicleId)===String(display.vehicleId)&&item.telemetry?.telemetry_source==='RECORDED_GPS')?.telemetry;
      const replay=replayFix?replayProgressOnRoute(display.plannedRoute?.routeGeojson,replayFix):null;
      if(replay){progress=replay;label=replay.label}
      else label=display.replayPreview?'진행률 대기 중 · Android GPS 재생이 시작되면 표시됩니다':'실제 GPS 위치를 기다리는 중';
    }
  }
  document.querySelector('#selected-progress').textContent=label;
  const track=document.querySelector('#trip-track');
  track.style.setProperty('--trip-progress',`${Math.max(0,Math.min(100,progress?.percent??0))}%`);
  track.classList.toggle('no-progress',!progress);
}
async function loadSelectedTrip(){
  const item=selected,request=++displayRequest;
  if(demoMode){
    clearTripLayers();
    if(item?.plannedRoute?.routeGeojson)routeLayer=L.geoJSON(item.plannedRoute.routeGeojson,{style:{color:'#0868dd',weight:6}}).addTo(map);
    document.querySelector('#trip-progress-card').hidden=true;
    document.querySelector('#route-label').textContent=`계획 경로 · ${item?.plannedRoute?.routeSource||'경로 없음'}`;
    return;
  }
  if(!item?.tripId){clearTripLayers();document.querySelector('#trip-progress-card').hidden=true;return}
  try{
    const display=await api(`/api/v1/trips/${item.tripId}/display`,{},true);
    if(request!==displayRequest||String(selected?.tripId)!==String(display.tripId))return;
    showTripDisplay(display);
  }catch(ex){if(request===displayRequest)document.querySelector('#route-label').textContent=`운행 경로 확인 실패 · ${ex.message}`}
}
function selectVehicle(item){
  selected=item;
  const assignmentVehicle=document.querySelector('#trip-vehicle');
  if(assignmentVehicle&&[...assignmentVehicle.options].some(option=>option.value===String(item.vehicleId))){
    assignmentVehicle.value=String(item.vehicleId);void loadAssignmentPreview();
  }
  syncLiveViewButton(item);
  details.hidden=false;
  renderVehicleDetails(item);
  for(const entry of markers.values()){
    const active=entry.item.telemetry?.external_id===item.telemetry?.external_id;
    entry.marker.setIcon(vehicleIcon(entry.item,active));
    entry.marker.setZIndexOffset(active?1000:0);
    if(entry.marker.getTooltip())entry.marker.getTooltip().options.permanent=active;
    if(active)entry.marker.openTooltip();else entry.marker.closeTooltip();
  }
  const t=item.telemetry;
  fields.replaceChildren();
  for(const [label,value] of [[uiText('Vehicle'),item.vehicleName||item.vehicleCode||t.external_id],[uiText('Source'),`${item.vehicleSource||'BIMS'} / ${t.telemetry_source}`],[uiText('Status'),item.vehicleStatus||t.source_metadata?.state||'ACTIVE'],[uiText('Speed'),`${t.speed_kmh??'—'} km/h`],[uiText('Observed'),t.observed_at_utc||'—'],[uiText('Trip ID'),item.tripId??'—']]){
    const term=document.createElement('dt'),description=document.createElement('dd');
    term.textContent=label;description.textContent=String(value);fields.append(term,description);
  }
  void loadSelectedTrip();
  document.querySelector('#recording-trip-id').value=item.tripId?String(item.tripId):'';
  if(item.tripId)void loadTripRecordings(String(item.tripId));
  retargetLiveView(item);
}
window.__operatorCancelMapPick=()=>{tripMapPick=undefined;document.querySelector('#map-pick-banner').hidden=true;document.querySelectorAll('[data-trip-map-pick]').forEach(button=>button.setAttribute('aria-pressed','false'));};
function render(snapshot){
  if(window.__virtualMode)return;
  if(!Array.isArray(snapshot?.vehicles))throw new Error('차량 응답 형식이 올바르지 않습니다.');
  latestFleet=snapshot.vehicles;
  let invalidPositions=0;
  const keys=new Set(snapshot.vehicles.map(item=>item.telemetry?.external_id));
  for(const [key,entry] of markers){if(!keys.has(key)&&key!==liveView?.markerKey){map.removeLayer(entry.marker);markers.delete(key);}}
  if(selected&&!snapshot.vehicles.some(item=>item.telemetry?.external_id===selected.telemetry?.external_id))syncLiveViewButton(null);
  for(const item of snapshot.vehicles){
    const pos=fleetPosition(item);
    if(!pos){invalidPositions++;const invalidEntry=markers.get(item.telemetry?.external_id);if(invalidEntry){map.removeLayer(invalidEntry.marker);markers.delete(item.telemetry.external_id);}continue;}
    const t=item.telemetry,key=t.external_id;
    let entry=markers.get(key);
    if(!entry)entry=createMarkerEntry(item,pos);
    else{entry.item=item;entry.liveOnly=false}
    if(selected?.telemetry?.external_id===key){selected=entry.item;syncLiveViewButton();renderVehicleDetails(item);void loadSelectedTrip()}
    // A new Android stream reuses device:<vehicleId>; reveal it again when its
    // recording session changes, even though the Leaflet marker already exists.
    revealAndroidMarker(item,pos);
    const liveSelected=liveView?.markerKey===key;
    entry.marker.setIcon(vehicleIcon(item,liveSelected||selected?.telemetry?.external_id===key));
    entry.marker.setZIndexOffset(liveSelected||selected?.telemetry?.external_id===key?1000:0);
    // Live frames own the selected marker between successful fleet polls.
    if(!isLiveOverride(liveView,key,Date.now())){
      entry.marker.setLatLng(pos);
      if(liveView?.markerKey===key&&liveMapFollower.isFollowing())liveMapFollower.update(pos);
    }
    const session=t.source_metadata?.recordingSessionId;
    // A new stream session supersedes the old one; reject its late frames.
    if(liveView?.markerKey===key&&typeof session==='string'&&session!==liveView.recordingSessionId)liveView.recordingSessionId=session;
    const label=document.createElement('span');label.textContent=t.telemetry_source==='RECORDED_GPS'?`Android GPS 재생 · ${item.vehicleCode||key}`:isAndroidGpsItem(item)?`Android GPS · ${item.vehicleCode||key}`:item.vehicleCode||key;entry.marker.setTooltipContent(label);
  }
  dashboard.update(snapshot.vehicles);
  if(!liveView&&!snapshot.vehicles.some(isAndroidGpsItem))fleetViewport.fit(snapshot.vehicles,{initial:true});
  const warnings=snapshot.warnings||[];
  const notice=document.querySelector('#fleet-status');
  notice.hidden=Boolean(snapshot.vehicles.length)&&!invalidPositions&&!warnings.length;
  notice.textContent=[!snapshot.vehicles.length?'수신된 차량이 없습니다. 설정에서 데이터 소스를 확인하세요.':'',invalidPositions?`위치가 없는 차량 ${invalidPositions}대`:'',...warnings.map(warning=>typeof warning==='string'?warning:warning.message||warning.code||'차량 데이터 소스 경고')].filter(Boolean).join(' · ');
  if(invalidPositions||warnings.length)console.warn('[operator fleet]',{received:snapshot.vehicles.length,invalidPositions,warnings});
}
async function refresh(){try{const snapshot=await api('/api/v1/tracking/vehicles');render(snapshot);if(document.querySelector('#trip-vehicle').value)void loadAssignmentPreview();error.textContent='';document.querySelector('#connection').textContent=`관제 연결됨 · ${snapshot.vehicles.length}대`}catch(e){console.error('[operator fleet] Fetch or render failed',e);error.textContent=e.message;document.querySelector('#connection').textContent='연결 확인 필요';const notice=document.querySelector('#fleet-status');notice.hidden=false;notice.textContent=`차량을 표시할 수 없습니다: ${e.message}`}}
const telemetryModeSelect=document.querySelector('#telemetry-mode'),telemetryModeApply=document.querySelector('#telemetry-mode-apply'),telemetryModeStatus=document.querySelector('#telemetry-mode-status'),telemetrySettings=document.querySelector('#telemetry-settings');
const telemetryModeLabel=mode=>mode==='live'?'Live BIMS':'Replay dataset';
const historyCompensation=document.querySelector('#history-compensation');
let telemetrySettingsEditing=false;
telemetryModeSelect.addEventListener('change',()=>{telemetrySettingsEditing=true});
historyCompensation.addEventListener('change',()=>{telemetrySettingsEditing=true});
function canChangeTelemetryMode(){return !demoMode&&['ADMIN','OPERATOR'].includes(currentRole)}
function renderTelemetryMode(result){
  if(!result||!telemetryModeSelect)return;
  if(!telemetrySettingsEditing){telemetryModeSelect.value=result.mode;historyCompensation.checked=result.historyCompensationEnabled===true;}
  document.querySelector('#fleet-source').textContent=result.mode==='live'?'소스: 실시간 BIMS':'소스: 저장된 GPS';
  telemetryModeStatus.textContent=`Active source: ${telemetryModeLabel(result.mode)}${result.available?'':' · routing is starting'}`;
  telemetryModeStatus.dataset.level=result.available?'ok':'warn';
  telemetryModeApply.disabled=!canChangeTelemetryMode();
  telemetryModeSelect.disabled=!canChangeTelemetryMode();
  historyCompensation.disabled=!canChangeTelemetryMode();
}
async function loadTelemetryMode(){
  if(!telemetryModeSelect)return;
  try{renderTelemetryMode(await api('/api/v1/tracking/telemetry-mode'))}
  catch(ex){telemetryModeStatus.textContent=`Telemetry source unavailable: ${ex.message}`;telemetryModeStatus.dataset.level='error';telemetryModeApply.disabled=true;telemetryModeSelect.disabled=true}
}
async function applyTelemetryMode(){
  if(!canChangeTelemetryMode()){
    telemetryModeStatus.textContent='Sign in as an operator or admin to change the source.';
    telemetryModeStatus.dataset.level='error';
    return;
  }
  const mode=telemetryModeSelect.value;telemetryModeApply.disabled=true;telemetryModeSelect.disabled=true;telemetryModeStatus.textContent=`Switching to ${telemetryModeLabel(mode)}…`;telemetryModeStatus.dataset.level='warn';
  try{const result=await api('/api/v1/tracking/telemetry-mode',{method:'PUT',body:JSON.stringify({mode,historyCompensationEnabled:historyCompensation.checked})},true);telemetrySettingsEditing=false;renderTelemetryMode(result);await refresh()}
  catch(ex){telemetryModeStatus.textContent=`Could not switch telemetry source: ${ex.message}`;telemetryModeStatus.dataset.level='error';await loadTelemetryMode()}
}
const tripRouteMode=document.querySelector('#trip-route-mode');
// The Android GPS path is the default; the optimal-route mode is opt-in.
tripRouteMode.value=localStorage.getItem('operatorTripRouteMode')==='DUAL'?'DUAL':'REPLAY_ONLY';
function syncTripRouteMode(){
  const replayOnly=tripRouteMode.value==='REPLAY_ONLY';
  document.querySelector('#trip-mode-hint').textContent=replayOnly
    ?'Android GPS 기록의 첫 위치에서 마지막 위치까지 배정합니다. 목적지는 자동 지정됩니다.'
    :'목적지를 선택하면 최적 경로와 Android GPS 재생 경로를 함께 표시합니다.';
  // The replay path's final GPS point is the destination, so there is nothing to ask.
  document.querySelector('#trip-destination-fields').hidden=replayOnly;
  for(const id of ['trip-destination-name','trip-destination-latitude','trip-destination-longitude']){
    const field=document.getElementById(id);field.disabled=replayOnly;field.required=!replayOnly;
  }
  if(replayOnly&&tripMapPick==='destination')window.__operatorCancelMapPick();
  const preview=assignmentPreview,notice=document.querySelector('#trip-preview-status');
  notice.textContent=preview?`Android GPS: ${preview.datasetName} · 마지막 위치 ${preview.points.at(-1)[2].toFixed(5)}, ${preview.points.at(-1)[1].toFixed(5)}`
    :replayOnly?'이 차량의 Android 앱에서 GPS 데이터셋을 먼저 선택하세요.':'Android GPS 미수신 · 경로가 도착하면 함께 표시됩니다.';
  // The server rejects a second active assignment; say so before the operator submits.
  const activeTripId=activeTripByVehicle.get(document.querySelector('#trip-vehicle').value);
  if(activeTripId)notice.textContent=`Trip ID ${activeTripId}이(가) 이미 배정되어 있습니다. 취소하거나 완료한 뒤 새로 배정하세요.`;
  document.querySelector('#create-trip').disabled=Boolean(activeTripId)||(replayOnly&&!preview);
  showAssignmentPreview(replayOnly&&!activeTripId&&!document.querySelector('#trip-form').hidden?preview:null);
}
// Before a replay-only assignment, draw the exact path and endpoint the server
// will pin, so the operator never assigns a destination they have not seen.
function showAssignmentPreview(preview){
  const key=preview?`${assignmentPreviewVehicleId}:${preview.fingerprint}`:'';
  if(key===assignmentPreviewKey)return;
  if(assignmentPreviewLayer)map.removeLayer(assignmentPreviewLayer);
  assignmentPreviewLayer=null;assignmentPreviewKey=key;
  const points=preview?.points;
  if(!Array.isArray(points)||points.length<2)return;
  const path=points.map(point=>[point[2],point[1]]);
  assignmentPreviewLayer=L.layerGroup([
    L.polyline(path,{color:'#e78328',weight:4,opacity:0.75,dashArray:'4 6'}).bindTooltip(`배정 예정 Android GPS 경로 · ${preview.datasetName}`),
    L.circleMarker(path.at(-1),{radius:8,color:'#fff',weight:2,fillColor:'#e53955',fillOpacity:1}).bindTooltip('배정 예정 목적지 · GPS 기록 마지막 위치',{direction:'top'}),
  ]);
  // The virtual workspace owns the map while open; the layer is re-added when it closes.
  if(!window.__virtualMode)assignmentPreviewLayer.addTo(map);
}
tripRouteMode.addEventListener('change',()=>{localStorage.setItem('operatorTripRouteMode',tripRouteMode.value);syncTripRouteMode()});
syncTripRouteMode();
async function loadAssignmentPreview(){
  const vehicleId=document.querySelector('#trip-vehicle').value;
  if(vehicleId!==assignmentPreviewVehicleId){assignmentPreviewVehicleId=vehicleId;assignmentPreview=null;syncTripRouteMode()}
  if(!vehicleId)return;
  try{const preview=await api(`/api/v1/trips/vehicles/${vehicleId}/replay-preview`,{},true);
    if(document.querySelector('#trip-vehicle').value===vehicleId){assignmentPreview=preview;syncTripRouteMode()}}
  catch(ex){document.querySelector('#trip-preview-status').textContent=`Android GPS 경로 확인 실패 · ${ex.message}`}
}
document.querySelector('#trip-vehicle').addEventListener('change',()=>void loadAssignmentPreview());
async function loadTripAssignments(){
  const [vehicles,trips]=await Promise.all([api('/api/v1/vehicles',{},true),api('/api/v1/trips',{},true)]);
  const vehicleSelect=document.querySelector('#trip-vehicle'),previousVehicle=vehicleSelect.value;
  vehicleSelect.replaceChildren(new Option(uiText('Select a vehicle'),''));
  for(const vehicle of vehicles.filter(item=>item.isActive)){
    const label=[`Vehicle ${vehicle.vehicleId}`,vehicle.vehicleCode,vehicle.vehicleName,vehicle.vehicleStatus].filter(Boolean).join(' · ');
    vehicleSelect.add(new Option(label,String(vehicle.vehicleId)));
  }
  if(vehicles.some(item=>item.isActive&&String(item.vehicleId)===previousVehicle))vehicleSelect.value=previousVehicle;
  // Trips arrive newest first; name the newest active one, as Android's current-trip lookup does.
  activeTripByVehicle=new Map();
  for(const trip of trips)if(['READY','IN_PROGRESS','PAUSED'].includes(trip.tripStatus)&&!activeTripByVehicle.has(String(trip.vehicleId)))activeTripByVehicle.set(String(trip.vehicleId),String(trip.tripId));
  syncTripRouteMode();
  void loadAssignmentPreview();
  const list=document.querySelector('#trips-list');list.replaceChildren();
  for(const trip of trips){
    const row=document.createElement('li'),title=document.createElement('strong'),vehicle=document.createElement('span'),destination=document.createElement('span'),status=document.createElement('span');
    title.textContent=`Trip ID ${trip.tripId}`;
    vehicle.textContent=`Vehicle ID ${trip.vehicleId} · ${trip.vehicle.vehicleCode}${trip.vehicle.vehicleName?` · ${trip.vehicle.vehicleName}`:''}`;
    destination.textContent=`${trip.originName?`${trip.originName} → `:''}${trip.destinationName}`;
    status.textContent=`${TRIP_STATUS_LABELS[trip.tripStatus]||trip.tripStatus} · ${trip.routeMode==='REPLAY_ONLY'?'Android GPS 재생 경로만':'최적 경로 + Android GPS 재생'}${trip.plannedStartAt?` · planned ${new Date(trip.plannedStartAt).toLocaleString()}`:''}`;
    row.append(title,vehicle,destination,status);
    if(['READY','IN_PROGRESS','PAUSED'].includes(trip.tripStatus)&&['ADMIN','OPERATOR'].includes(currentRole)){
      const cancel=document.createElement('button');cancel.type='button';cancel.textContent='운행 취소';
      cancel.onclick=async()=>{if(!window.confirm(`Trip ID ${trip.tripId} 배정을 취소할까요?`))return;
        cancel.disabled=true;try{await api(`/api/v1/trips/${trip.tripId}/cancel`,{method:'POST',body:'{}'},true);await loadTripAssignments();await refresh()}
        catch(ex){document.querySelector('#trip-status-message').textContent=ex.message;cancel.disabled=false}};
      row.append(cancel);
    }
    list.append(row);
  }
  if(!vehicles.some(item=>item.isActive))vehicleSelect.replaceChildren(new Option(uiText('No active vehicles available'),''));
  if(!trips.length){const empty=document.createElement('li');empty.textContent=uiText('No trips created yet.');list.append(empty)}
}
async function start(role){
  currentRole=demoMode?'':(role||'');
  updateRecordingDeleteTools();
  document.querySelector('#login').hidden=!demoMode;
  telemetrySettings.hidden=false;
  bootstrap=await api('/api/v1/bootstrap');
  document.querySelector('#trip-panel').hidden=demoMode;
  if(!demoMode){
    document.querySelector('#trip-form').hidden=!['ADMIN','OPERATOR'].includes(role);
    document.querySelector('#trip-status-message').textContent=['ADMIN','OPERATOR'].includes(role)?uiText('Choose a vehicle and destination.'):'You can review recent trips; an operator or admin can create one.';
  }
  await refresh();
  if(!demoMode){
    // BIMS vehicle identities are populated by the fleet snapshot before the assignment list loads.
    void loadTripAssignments().catch(ex=>{document.querySelector('#trip-status-message').textContent=`운행 목록을 불러올 수 없습니다: ${ex.message}`;console.error('[operator trips]',ex)});
  }
  await loadTelemetryMode();
  clearInterval(telemetryModeTimer);telemetryModeTimer=setInterval(()=>void loadTelemetryMode(),5000);
  if(!refreshTimer)refreshTimer=setInterval(refresh,3000);
}
async function autoLogin(){
  if(token)return true;
  try{
    const result=await api('/api/v1/auth/login',{method:'POST',body:JSON.stringify({loginId:'admin',password:'admin1234'})},true);
    token=result.accessToken;
    sessionStorage.setItem('itsToken',token);
    return true;
  }catch{return false}
}
async function requireRecordingLogin(){
  if(token&&!demoMode)return;
  if(demoMode&&await autoLogin()){
    demoMode=false;
    const auth=await api('/api/v1/auth/me',{},true);
    await start(auth.role);
    return;
  }
  throw new Error('Sign in before accessing trip recordings');
}
function replayPlayer(){return document.querySelector('#recording-player')}
function replayCurrentTime(){const entry=replayTimeline[replayIndex];return entry?entry.start+replayPlayer().currentTime:0}
function formatReplayTime(value){const seconds=Math.max(0,Math.floor(Number(value)||0)),hours=Math.floor(seconds/3600),minutes=Math.floor((seconds%3600)/60),remainder=seconds%60;return hours?`${hours}:${String(minutes).padStart(2,'0')}:${String(remainder).padStart(2,'0')}`:`${minutes}:${String(remainder).padStart(2,'0')}`}
function clearReplayOverlay(){const canvas=document.querySelector('#recording-overlay'),context=canvas.getContext('2d');context.clearRect(0,0,canvas.width,canvas.height)}
function stopRecordingPlayback(){const player=replayPlayer();replayGeneration++;replaySeekGeneration++;replayScrubbing=false;replayScrubWasPlaying=false;replaySeekPending=false;player.pause();player.removeAttribute('src');player.load();replayIndex=-1;clearReplayOverlay();document.querySelector('#recording-play').textContent='재생';document.querySelector('#recording-time').textContent=`0:00 / ${formatReplayTime(replayDuration)}`;document.querySelector('#recording-seek').value='0'}
function setReplayPosition(value){const position=Math.max(0,Math.min(replayDuration,Number(value)||0));document.querySelector('#recording-seek').value=String(position);document.querySelector('#recording-time').textContent=`${formatReplayTime(position)} / ${formatReplayTime(replayDuration)}`}
function renderReplayBreakMarkers(){const markers=document.querySelector('#recording-break-markers');markers.replaceChildren();for(const entry of replayTimeline){if(entry.breakBefore){const marker=document.createElement('span');marker.style.left=`${replayDuration?entry.start/replayDuration*100:0}%`;marker.title=`Recording break before segment ${entry.video.segmentIndex}`;markers.append(marker)}}}
function updateRecordingDeleteTools(){document.querySelector('#recording-delete-tools').hidden=!['ADMIN','OPERATOR'].includes(currentRole)||!replayTimeline.length}
function clearRecordingDeleteSelection(){document.querySelector('#recording-delete-selection').hidden=true;document.querySelector('#recording-delete-selected').disabled=true;document.querySelector('#recording-delete-selection-status').textContent=uiText('No segments selected.');recordingDeleteRange=null;recordingDeleteDrag=null}
function openRecordingDeleteMode(){if(!replayTimeline.length)return;renderRecordingDeleteTimeline();document.querySelector('#recording-delete-mode').hidden=false;document.querySelector('#recording-timeline').classList.add('is-delete-mode');document.querySelector('#recording-seek').disabled=true;document.querySelector('#recording-delete-range').hidden=false;replayPlayer().pause();document.querySelector('#recording-delete-toggle').textContent=uiText('Exit delete mode');document.querySelector('#recording-delete-range').focus()}
function closeRecordingDeleteMode(){document.querySelector('#recording-delete-mode').hidden=true;document.querySelector('#recording-delete-toggle').textContent=uiText('Delete segments');document.querySelector('#recording-timeline').classList.remove('is-delete-mode');document.querySelector('#recording-seek').disabled=false;document.querySelector('#recording-delete-range').hidden=true;document.querySelector('#recording-delete-segments').replaceChildren();clearRecordingDeleteSelection()}
function renderRecordingDeleteTimeline(){const segments=document.querySelector('#recording-delete-segments');segments.replaceChildren();for(const entry of replayTimeline){const marker=document.createElement('span');marker.style.left=`${entry.start/replayDuration*100}%`;marker.style.width=`${entry.duration/replayDuration*100}%`;marker.title=`Segment ${entry.video.segmentIndex} · ${formatReplayTime(entry.start)}–${formatReplayTime(entry.end)}`;segments.append(marker)}}
function setRecordingDeleteRange(firstIndex,lastIndex){if(!replayTimeline.length)return;const first=Math.max(0,Math.min(replayTimeline.length-1,Math.min(firstIndex,lastIndex))),last=Math.max(first,Math.min(replayTimeline.length-1,Math.max(firstIndex,lastIndex)));recordingDeleteRange={first,last};const firstEntry=replayTimeline[first],lastEntry=replayTimeline[last],selection=document.querySelector('#recording-delete-selection'),left=firstEntry.start/replayDuration*100,right=lastEntry.end/replayDuration*100;selection.style.left=`${left}%`;selection.style.width=`${Math.max(0,right-left)}%`;selection.hidden=false;document.querySelector('#recording-delete-selected').disabled=false;document.querySelector('#recording-delete-selection-status').textContent=`${last-first+1} contiguous segment${last===first?'':'s'} selected · segments ${firstEntry.video.segmentIndex}–${lastEntry.video.segmentIndex} · ${formatReplayTime(firstEntry.start)}–${formatReplayTime(lastEntry.end)}.`}
function recordingDeleteIndexAt(clientX){const range=document.querySelector('#recording-delete-range').getBoundingClientRect(),ratio=Math.max(0,Math.min(1,(clientX-range.left)/Math.max(1,range.width))),position=ratio*replayDuration;let index=replayTimeline.findIndex((entry,current)=>position>=entry.start&&(position<entry.end||(current===replayTimeline.length-1&&position<=entry.end)));if(index<0)index=position>=replayDuration?replayTimeline.length-1:0;return index}
function adjustRecordingDeleteRange(event){if(!replayTimeline.length)return;const delta=event.key==='ArrowRight'||event.key==='ArrowUp'?1:event.key==='ArrowLeft'||event.key==='ArrowDown'?-1:0;if(event.key==='Home'){event.preventDefault();setRecordingDeleteRange(0,0);return}if(event.key==='End'){event.preventDefault();setRecordingDeleteRange(replayTimeline.length-1,replayTimeline.length-1);return}if(!delta)return;event.preventDefault();if(!recordingDeleteRange){const index=replayIndex>=0?replayIndex:0;setRecordingDeleteRange(index,index);return}if(event.shiftKey){const first=Math.max(0,Math.min(recordingDeleteRange.last,recordingDeleteRange.first+delta));setRecordingDeleteRange(first,recordingDeleteRange.last)}else{const last=Math.max(recordingDeleteRange.first,Math.min(replayTimeline.length-1,recordingDeleteRange.last+delta));setRecordingDeleteRange(recordingDeleteRange.first,last)}}
function beginRecordingDeleteRange(event){if(event.button!==0||!replayTimeline.length)return;event.preventDefault();const range=document.querySelector('#recording-delete-range'),index=recordingDeleteIndexAt(event.clientX);recordingDeleteDrag={pointerId:event.pointerId,anchor:index};range.setPointerCapture(event.pointerId);setRecordingDeleteRange(index,index)}
function moveRecordingDeleteRange(event){if(!recordingDeleteDrag||recordingDeleteDrag.pointerId!==event.pointerId)return;setRecordingDeleteRange(recordingDeleteDrag.anchor,recordingDeleteIndexAt(event.clientX))}
function finishRecordingDeleteRange(event){if(!recordingDeleteDrag||recordingDeleteDrag.pointerId!==event.pointerId)return;recordingDeleteDrag=null}
async function deleteSelectedRecordingSegments(){if(!recordingDeleteRange)return;const selected=replayTimeline.slice(recordingDeleteRange.first,recordingDeleteRange.last+1),first=selected[0],last=selected.at(-1);if(!selected.length)return;const prompt=`Permanently delete ${selected.length} contiguous recording segment${selected.length===1?'':'s'} from trip ${replayTripId} (segments ${first.video.segmentIndex}–${last.video.segmentIndex}, ${formatReplayTime(first.start)}–${formatReplayTime(last.end)}) and their replay detections?`;if(!window.confirm(prompt))return;const button=document.querySelector('#recording-delete-selected'),tripId=replayTripId;button.disabled=true;stopRecordingPlayback();document.querySelector('#recordings-status').textContent=`Deleting ${selected.length} recording segment${selected.length===1?'':'s'}…`;let deleted=0;const failures=[];for(const entry of selected){try{await api(`/api/v1/trip-videos/${encodeURIComponent(entry.video.tripVideoId)}`,{method:'DELETE'},true);deleted++}catch(ex){failures.push(ex.message)}}await loadTripRecordings(tripId,true);const deleteModeActive=!document.querySelector('#recording-delete-mode').hidden,tail=deleteModeActive?'Delete mode remains active.':'No segments remain for this trip.';document.querySelector('#recordings-status').textContent=failures.length?`Deleted ${deleted} of ${selected.length} segments. ${failures.length} failed: ${failures[0]} ${tail}`:`Deleted ${deleted} segment${deleted===1?'':'s'} and their replay detections. ${tail}`}
function waitForVideoMetadata(player){return new Promise((resolve,reject)=>{const loaded=()=>{cleanup();resolve()},failed=()=>{cleanup();reject(new Error('The recording video could not be loaded'))},cleanup=()=>{player.removeEventListener('loadedmetadata',loaded);player.removeEventListener('error',failed)};if(player.readyState>=1){resolve();return}player.addEventListener('loadedmetadata',loaded,{once:true});player.addEventListener('error',failed,{once:true})})}
function loadReplayDetections(entry){if(entry.samplesLoaded)return Promise.resolve();if(entry.sampleLoadPromise)return entry.sampleLoadPromise;entry.sampleLoadPromise=api(`/api/v1/trips/${encodeURIComponent(replayTripId)}/videos/${encodeURIComponent(entry.video.tripVideoId)}/detections`,{},true).then(result=>{entry.samples=result.samples||[];entry.coverageIncomplete=Boolean(result.coverageIncomplete)}).catch(()=>{entry.samples=[];entry.coverageIncomplete=true}).finally(()=>{entry.samplesLoaded=true;entry.sampleLoadPromise=null;renderReplayBreakMarkers();if(replayTimeline[replayIndex]===entry)drawReplayOverlay()});return entry.sampleLoadPromise}
async function activateReplaySegment(index,localTime,autoplay,generation){const entry=replayTimeline[index],player=replayPlayer();if(!entry||entry.unavailable)throw new Error('This recording segment is unavailable');const switchSegment=replayIndex!==index||!player.currentSrc,urlPromise=switchSegment?api(`/api/v1/trip-videos/${encodeURIComponent(entry.video.tripVideoId)}/playback-url`,{method:'POST'},true):Promise.resolve({url:entry.playbackUrl});const [url]=await Promise.all([urlPromise,loadReplayDetections(entry)]);if(generation!==replayGeneration)return false;if(switchSegment){entry.playbackUrl=url.url;player.src=url.url;player.load();await waitForVideoMetadata(player);if(generation!==replayGeneration)return false}replayIndex=index;const safeDuration=Number.isFinite(player.duration)?player.duration:entry.duration;player.currentTime=Math.min(Math.max(0,localTime),Math.max(0,safeDuration-.02));setReplayPosition(entry.start+player.currentTime);if(autoplay)await player.play();drawReplayOverlay();return true}
async function seekReplay(position,autoplay=true,direction=1,preferredIndex=-1){if(!replayTimeline.length)return;const generation=++replayGeneration,player=replayPlayer();player.pause();let target=Math.max(0,Math.min(replayDuration,Number(position)||0));let index=preferredIndex>=0?preferredIndex:entryForTime(replayTimeline,replayDuration,target,direction);if(index<0)index=direction<0?replayTimeline.length-1:0;for(let attempt=0;attempt<replayTimeline.length;attempt++){const entry=replayTimeline[index];if(entry.unavailable){index+=direction;if(index<0||index>=replayTimeline.length)break;target=replayTimeline[index].start;continue}try{const ok=await activateReplaySegment(index,Math.max(0,target-entry.start),autoplay,generation);if(!ok)return;document.querySelector('#recordings-status').textContent=`Playing trip timeline · segment ${entry.video.segmentIndex} of ${replayTimeline.length}.`;return}catch(ex){if(generation!==replayGeneration)return;entry.unavailable=true;renderReplayBreakMarkers();document.querySelector('#recordings-status').textContent=`Segment ${entry.video.segmentIndex} is unavailable (${ex.message}); skipping to the next segment.`;index+=direction;if(index<0||index>=replayTimeline.length)break;target=replayTimeline[index].start}}player.pause();document.querySelector('#recordings-status').textContent='No playable recording segments remain in this direction.'}
async function loadTripRecordings(value,keepDeleteMode=false){const deleteMode=document.querySelector('#recording-delete-mode'),resumeDeleteMode=keepDeleteMode&&!deleteMode.hidden;if(resumeDeleteMode){clearRecordingDeleteSelection();document.querySelector('#recording-delete-segments').replaceChildren()}else{closeRecordingDeleteMode();document.querySelector('#recording-delete-tools').hidden=true}const requestId=++recordingsRequest,tripId=String(value||'').trim(),status=document.querySelector('#recordings-status');replayTimeline=[];replayDuration=0;replayTripId=tripId;renderReplayBreakMarkers();stopRecordingPlayback();document.querySelector('#recording-player-panel').hidden=true;if(!/^[1-9][0-9]{0,18}$/.test(tripId)){status.textContent='Select a vehicle with a trip or enter a positive Trip ID.';return}status.textContent=`Loading trip ${tripId}…`;try{await requireRecordingLogin();const videos=await api(`/api/v1/trips/${encodeURIComponent(tripId)}/videos`,{},true);if(requestId!==recordingsRequest)return;if(!videos.length){closeRecordingDeleteMode();document.querySelector('#recording-delete-tools').hidden=true;renderReplayBreakMarkers();status.textContent=`No finalized recording segments are available for trip ${tripId}.`;return}const timeline=buildReplayTimeline(videos);replayTimeline=timeline.entries;replayDuration=timeline.duration;renderReplayBreakMarkers();updateRecordingDeleteTools();if(!replayTimeline.length){closeRecordingDeleteMode();document.querySelector('#recording-delete-tools').hidden=true;status.textContent=`Trip ${tripId} has no segments with a usable duration.`;return}document.querySelector('#recording-player-panel').hidden=false;const seek=document.querySelector('#recording-seek');seek.max=String(replayDuration);seek.value='0';document.querySelector('#recording-time').textContent=`0:00 / ${formatReplayTime(replayDuration)}`;if(resumeDeleteMode)openRecordingDeleteMode();status.textContent=resumeDeleteMode?`Trip ${tripId}: ${replayTimeline.length} segments remain. Delete mode is active; select another range to continue.`:`Trip ${tripId}: ${replayTimeline.length} segments, ${formatReplayTime(replayDuration)} total. Loading detections as segments play.`;await seekReplay(0,false)}catch(ex){if(requestId!==recordingsRequest)return;if(resumeDeleteMode&&!replayTimeline.length){closeRecordingDeleteMode();document.querySelector('#recording-delete-tools').hidden=true;renderReplayBreakMarkers()}status.textContent=ex.message}}
function drawReplayOverlay(mediaTime){
  const canvas=document.querySelector('#recording-overlay'),player=replayPlayer(),entry=replayTimeline[replayIndex];
  if(!entry||player.videoWidth<=0||player.videoHeight<=0){clearReplayOverlay();return}
  const rect=canvas.getBoundingClientRect(),ratio=window.devicePixelRatio||1;
  if(canvas.width!==Math.round(rect.width*ratio)||canvas.height!==Math.round(rect.height*ratio)){canvas.width=Math.round(rect.width*ratio);canvas.height=Math.round(rect.height*ratio)}
  const context=canvas.getContext('2d');context.clearRect(0,0,canvas.width,canvas.height);context.setTransform(ratio,0,0,ratio,0,0);
  const frameTime=Number.isFinite(mediaTime)?mediaTime:player.currentTime,localPts=BigInt(entry.video.startPts90k)+BigInt(Math.round(frameTime*90000)),sample=detectionSampleAtPts(entry.samples,localPts);
  const overlayStatus=document.querySelector('#recording-overlay-status');overlayStatus.textContent=entry.coverageIncomplete?`Detection coverage is incomplete for segment ${entry.video.segmentIndex}.`:`Detection overlay · segment ${entry.video.segmentIndex}`;
  if(!sample||!sample.detections?.length)return;
  const scale=Math.min(rect.width/player.videoWidth,rect.height/player.videoHeight),drawWidth=player.videoWidth*scale,drawHeight=player.videoHeight*scale,left=(rect.width-drawWidth)/2,top=(rect.height-drawHeight)/2;
  context.lineWidth=2;context.font='bold 12px system-ui, sans-serif';
  for(const detection of sample.detections){const [x1,y1,x2,y2]=detection.bbox||[];if(![x1,y1,x2,y2].every(Number.isFinite))continue;const x=left+x1*drawWidth,y=top+y1*drawHeight,w=Math.max(1,(x2-x1)*drawWidth),h=Math.max(1,(y2-y1)*drawHeight);context.strokeStyle='#35e69b';context.strokeRect(x,y,w,h);const label=`${detection.class} ${Number(detection.confidence).toFixed(2)}`;const labelWidth=context.measureText(label).width+8;context.fillStyle='#04251de8';context.fillRect(x,Math.max(top,y-19),labelWidth,18);context.fillStyle='#eafff5';context.fillText(label,x+4,Math.max(top+13,y-6))}
}
let replayOverlayFrameGeneration=0,replayVideoFrameCallback=null,replayAnimationFrame=null;
function stopReplayOverlayFrameLoop(){replayOverlayFrameGeneration++;const player=replayPlayer();if(replayVideoFrameCallback!==null&&typeof player.cancelVideoFrameCallback==='function')player.cancelVideoFrameCallback(replayVideoFrameCallback);if(replayAnimationFrame!==null)cancelAnimationFrame(replayAnimationFrame);replayVideoFrameCallback=null;replayAnimationFrame=null}
function startReplayOverlayFrameLoop(){stopReplayOverlayFrameLoop();const player=replayPlayer(),generation=replayOverlayFrameGeneration;function drawNext(){if(generation!==replayOverlayFrameGeneration||player.paused||player.ended)return;if(typeof player.requestVideoFrameCallback==='function'){replayVideoFrameCallback=player.requestVideoFrameCallback((_now,metadata)=>{replayVideoFrameCallback=null;if(generation!==replayOverlayFrameGeneration||player.paused||player.ended)return;drawReplayOverlay(metadata.mediaTime);drawNext()})}else{replayAnimationFrame=requestAnimationFrame(()=>{replayAnimationFrame=null;if(generation!==replayOverlayFrameGeneration||player.paused||player.ended)return;drawReplayOverlay();drawNext()})}}drawNext()}
function beginReplayScrub(){if(replayScrubbing)return;replayScrubbing=true;replayScrubWasPlaying=!replayPlayer().paused;if(replayScrubWasPlaying)replayPlayer().pause()}
async function commitReplayScrub(value){if(!replayScrubbing)beginReplayScrub();const autoplay=replayScrubWasPlaying,generation=++replaySeekGeneration;replayScrubbing=false;replayScrubWasPlaying=false;replaySeekPending=true;try{await seekReplay(value,autoplay,1)}finally{if(generation===replaySeekGeneration)replaySeekPending=false}}
const replayFullscreenButton=document.querySelector('#recording-fullscreen'),replayPanel=document.querySelector('#recording-player-panel');
function syncReplayFullscreenButton(){const isFullscreen=document.fullscreenElement===replayPanel;replayFullscreenButton.textContent=isFullscreen?'전체 화면 종료':'전체 화면';replayFullscreenButton.setAttribute('aria-label',isFullscreen?'Exit full-screen replay':'View replay full screen')}
if(!document.fullscreenEnabled||typeof replayPanel.requestFullscreen!=='function')replayFullscreenButton.hidden=true;
else{replayFullscreenButton.addEventListener('click',async()=>{try{if(document.fullscreenElement===replayPanel)await document.exitFullscreen();else await replayPanel.requestFullscreen()}catch{document.querySelector('#recordings-status').textContent='Full-screen replay is unavailable in this browser.'}});document.addEventListener('fullscreenchange',()=>{syncReplayFullscreenButton();requestAnimationFrame(()=>drawReplayOverlay())});syncReplayFullscreenButton()}
window.addEventListener('resize',()=>drawReplayOverlay());
replayPlayer().addEventListener('timeupdate',()=>{if(replayIndex<0||replayScrubbing||replaySeekPending)return;setReplayPosition(replayTimeline[replayIndex].start+replayPlayer().currentTime)});
replayPlayer().addEventListener('loadedmetadata',()=>drawReplayOverlay());
replayPlayer().addEventListener('seeked',()=>drawReplayOverlay());
replayPlayer().addEventListener('ended',()=>{stopReplayOverlayFrameLoop();if(replayIndex<0)return;const next=replayTimeline.findIndex((entry,index)=>index>replayIndex&&!entry.unavailable);if(next>=0)void seekReplay(replayTimeline[next].start,true,1,next);else document.querySelector('#recordings-status').textContent='Trip replay finished.'});
replayPlayer().addEventListener('error',()=>{if(replayIndex<0||replayPlayer().readyState<1)return;const failedIndex=replayIndex,entry=replayTimeline[failedIndex];entry.unavailable=true;renderReplayBreakMarkers();document.querySelector('#recordings-status').textContent=`Playback failed for segment ${entry.video.segmentIndex}; skipping to the next segment.`;const next=replayTimeline.findIndex((item,index)=>index>failedIndex&&!item.unavailable);if(next>=0)void seekReplay(replayTimeline[next].start,true,1,next)});
replayPlayer().addEventListener('play',()=>{document.querySelector('#recording-play').textContent='일시정지';startReplayOverlayFrameLoop()});
replayPlayer().addEventListener('pause',()=>{document.querySelector('#recording-play').textContent='재생';stopReplayOverlayFrameLoop();drawReplayOverlay()});
document.querySelector('#recording-play').addEventListener('click',()=>{const player=replayPlayer();if(!replayTimeline.length)return;if(!player.paused){player.pause();return}if(replayIndex<0)void seekReplay(0,true);else void player.play()});
document.querySelector('#recording-back').addEventListener('click',()=>void seekReplay(replayCurrentTime()-10,true,-1));
document.querySelector('#recording-forward').addEventListener('click',()=>void seekReplay(replayCurrentTime()+10,true,1));
document.querySelector('#recording-seek').addEventListener('input',event=>{beginReplayScrub();setReplayPosition(event.currentTarget.value)});
document.querySelector('#recording-seek').addEventListener('change',event=>void commitReplayScrub(event.currentTarget.value));
document.querySelector('#recordings-form').addEventListener('submit',event=>{event.preventDefault();void loadTripRecordings(document.querySelector('#recording-trip-id').value)});
document.querySelector('#stop-recording').addEventListener('click',stopRecordingPlayback);
document.querySelector('#recording-delete-toggle').addEventListener('click',event=>{const mode=document.querySelector('#recording-delete-mode');if(mode.hidden){openRecordingDeleteMode();document.querySelector('#recordings-status').textContent='Drag across the timeline to select a contiguous range of segments.'}else{closeRecordingDeleteMode();document.querySelector('#recordings-status').textContent='Delete mode closed.'}});
document.querySelector('#recording-delete-cancel').addEventListener('click',()=>{closeRecordingDeleteMode();document.querySelector('#recordings-status').textContent='Delete mode closed.'});
document.querySelector('#recording-delete-selected').addEventListener('click',()=>void deleteSelectedRecordingSegments());
const recordingDeleteRangeElement=document.querySelector('#recording-delete-range');
recordingDeleteRangeElement.addEventListener('pointerdown',beginRecordingDeleteRange);
recordingDeleteRangeElement.addEventListener('pointermove',moveRecordingDeleteRange);
recordingDeleteRangeElement.addEventListener('pointerup',finishRecordingDeleteRange);
recordingDeleteRangeElement.addEventListener('pointercancel',finishRecordingDeleteRange);
recordingDeleteRangeElement.addEventListener('keydown',adjustRecordingDeleteRange);
document.querySelector('#login').addEventListener('submit',async e=>{e.preventDefault();try{const f=new FormData(e.currentTarget),result=await api('/api/v1/auth/login',{method:'POST',body:JSON.stringify(Object.fromEntries(f))},true);token=result.accessToken;sessionStorage.setItem('itsToken',token);demoMode=false;await start(result.user.role)}catch(ex){error.textContent=ex.message;document.querySelector('#login-error').textContent=ex.message}});
telemetryModeApply.addEventListener('click',()=>void applyTelemetryMode());
function browserReachableUrl(configuredUrl){
  const url=new URL(configuredUrl,window.location.href);
  if(url.hostname==='127.0.0.1'||url.hostname==='localhost')url.hostname=window.location.hostname;
  return url.href;
}
let liveDetections=null;
function renderDetectionStatus(){
  document.querySelector('#live-detection-status').textContent=describeDetections(liveDetections?.counts,liveDetections?.receivedAt,Date.now());
}
function renderLiveTelemetryStatus(){
  renderDetectionStatus();
  const element=document.querySelector('#live-telemetry-status');
  const status=describeLiveTelemetry(liveView,lastLiveMessage,Date.now());
  const entry=liveView&&markers.get(liveView.markerKey);
  element.textContent=entry?.liveOnly&&status.text==='Live telemetry: stale - marker follows fleet polling'
    ?'Live telemetry: stale - showing last known position':status.text;
  element.dataset.level=status.level;
}
function stopLiveView(){
  if(document.fullscreenElement===livePanel)void document.exitFullscreen().catch(()=>{});
  releaseLiveMarker();
  // Navigating the iframe away from the Vision page closes its WebRTC peer
  // connection and releases the browser media resources.
  liveFrame.src='about:blank';
  livePanel.hidden=true;
  operatorLayout.classList.remove('live-view-open');
  document.querySelector('#live-view-diagnostic').textContent='';
  liveView=null;lastLiveMessage=null;liveVideoSize=null;liveDetections=null;fitLivePanelToVideo();
  document.querySelector('#live-view-title').textContent='실시간 전방 영상';
  clearInterval(liveStatusTimer);liveStatusTimer=undefined;
  refreshMapLayout();
  if(!document.querySelector('#details').hidden)document.querySelector('#live-view').focus({preventScroll:true});
  renderLiveTelemetryStatus();
}
// The virtual workspace takes over the map and the sidebar, so it closes Live
// View on the way in. Hiding the panel alone would leave the live-view-open
// layout class - and with it a display:none sidebar - behind.
window.__operatorStopLiveView=stopLiveView;
window.addEventListener('message',event=>{
  if(liveView&&event.origin===liveView.frameOrigin&&event.source===liveFrame.contentWindow&&event.data?.type==='live-view-video-size'){
    const {width,height}=event.data;
    if(Number.isFinite(width)&&Number.isFinite(height)&&width>0&&height>0){liveVideoSize={width,height};fitLivePanelToVideo()}
    return;
  }
  // Class counts describe whatever the frame shows, with or without a trip or telemetry.
  if(liveView&&event.origin===liveView.frameOrigin&&event.source===liveFrame.contentWindow&&event.data?.type==='live-vehicle-telemetry'&&event.data.detections&&typeof event.data.detections==='object'){
    liveDetections={counts:event.data.detections,receivedAt:Date.now()};renderDetectionStatus();
  }
  const message=acceptLiveTelemetry(liveView,event,liveFrame.contentWindow);
  if(!message)return;
  lastLiveMessage=message;
  const position=applyLiveTelemetry(liveView,message,Date.now());
  if(position)liveMapFollower.update(position);
  renderLiveTelemetryStatus();
});
installForegroundResume(window,document,()=>{
  if(!liveView||document.hidden)return;
  liveFrame.contentWindow?.postMessage({type:FOREGROUND_RESUME_MESSAGE},liveView.frameOrigin);
});
document.querySelector('#live-view').addEventListener('click',()=>{
  if(!bootstrap||!matchesLiveTarget(selected))return;
  const liveViewUrlObject=new URL(browserReachableUrl(bootstrap.liveViewUrl));
  liveViewUrlObject.searchParams.set('autostart','1');
  const liveViewUrl=liveViewUrlObject.href;
  const diagnostic=document.querySelector('#live-view-diagnostic');
  diagnostic.textContent=`Live View origin: ${new URL(liveViewUrl).origin}`;
  if(!window.isSecureContext)diagnostic.textContent+=' — dashboard is not a secure context; open its HTTPS URL';
  liveView=createLiveView(selected,new URL(liveViewUrl).origin);lastLiveMessage=null;
  liveMapFollower.begin(liveView);
  document.querySelector('#live-view-title').textContent=`실시간 영상 · ${liveTargetLabel(selected)}`;
  clearInterval(liveStatusTimer);liveStatusTimer=setInterval(renderLiveTelemetryStatus,1000);
  renderLiveTelemetryStatus();
  operatorLayout.classList.add('live-view-open');
  livePanel.hidden=false;
  fitLivePanelToVideo();
  refreshMapLayout();
  document.querySelector('#close-live-view').focus({preventScroll:true});
  // Set the URL only after opening the panel so navigation/playback starts as
  // part of the user's click instead of while the iframe is hidden.
  liveFrame.src=liveViewUrl;
});
liveFrame.addEventListener('load',event=>{
  if(livePanel.hidden)return;
  const diagnostic=document.querySelector('#live-view-diagnostic');
  try{
    diagnostic.textContent+=event.currentTarget.contentWindow.isSecureContext?' — secure context ready':' — iframe is not a secure context';
  }catch{
    diagnostic.textContent+=' — iframe loaded; inspect its console if playback does not start';
  }
  notifyLiveFrameFullscreen();
});
document.querySelector('#close-live-view').addEventListener('click',stopLiveView);
liveRecenterButton.addEventListener('click',()=>liveMapFollower.recenter());
const liveFullscreenButton=document.querySelector('#live-fullscreen');
function syncLiveFullscreenButton(){const fullscreen=document.fullscreenElement===livePanel;liveFullscreenButton.textContent=fullscreen?'전체 화면 종료':'전체 화면';liveFullscreenButton.setAttribute('aria-label',fullscreen?'Exit full-screen Live View':'View Live View full screen')}
if(!document.fullscreenEnabled||typeof livePanel.requestFullscreen!=='function')liveFullscreenButton.hidden=true;
else{
  liveFullscreenButton.addEventListener('click',async()=>{try{if(document.fullscreenElement===livePanel)await document.exitFullscreen();else await livePanel.requestFullscreen()}catch{document.querySelector('#live-view-diagnostic').textContent='Full-screen Live View is unavailable in this browser.'}});
  document.addEventListener('fullscreenchange',()=>{syncLiveFullscreenButton();notifyLiveFrameFullscreen();fitLivePanelToVideo();requestAnimationFrame(()=>map.invalidateSize({pan:false}))});
  syncLiveFullscreenButton();
}
document.querySelectorAll('[data-trip-map-pick]').forEach(button=>button.addEventListener('click',()=>{
  tripMapPick=button.dataset.tripMapPick;
  const banner=document.querySelector('#map-pick-banner');banner.hidden=false;banner.textContent=`지도에서 ${tripMapPick==='origin'?'출발지':'목적지'}를 선택하세요.`;
  document.querySelectorAll('[data-trip-map-pick]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));
  map.getContainer().style.cursor='crosshair';
  document.querySelector('#trip-status-message').textContent=`Click the map to set the ${tripMapPick} coordinates.`;
}));
map.on('click',event=>{
  if(!tripMapPick||window.__virtualMode)return;
  const kind=tripMapPick,label=kind==='origin'?'Origin':'Destination',prefix=kind==='origin'?'trip-origin':'trip-destination';
  const latitude=event.latlng.lat.toFixed(6),longitude=event.latlng.lng.toFixed(6);
  document.querySelector(`#${prefix}-latitude`).value=latitude;
  document.querySelector(`#${prefix}-longitude`).value=longitude;
  let marker=tripMapMarkers.get(kind);
  if(marker)marker.setLatLng(event.latlng);
  else{
    marker=L.circleMarker(event.latlng,{radius:9,color:'#fff',weight:3,fillColor:kind==='origin'?'#ff8a3d':'#20a4f3',fillOpacity:1}).addTo(map);
    marker.bindTooltip(label,{permanent:true,direction:'top',offset:[0,-8],className:'trip-point-label'});
    tripMapMarkers.set(kind,marker);
  }
  document.querySelector('#trip-status-message').textContent=`${label} set at ${latitude}, ${longitude}.`;
  document.querySelectorAll('[data-trip-map-pick]').forEach(button=>button.setAttribute('aria-pressed','false'));
  map.getContainer().style.cursor='';
  tripMapPick=undefined;
  document.querySelector('#map-pick-banner').hidden=true;
});
document.querySelector('#trip-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const form=event.currentTarget,button=document.querySelector('#create-trip'),message=document.querySelector('#trip-status-message');
  const value=id=>document.querySelector(`#${id}`).value.trim();
  const originLatitude=value('trip-origin-latitude'),originLongitude=value('trip-origin-longitude');
  if(Boolean(originLatitude)!==Boolean(originLongitude)){message.textContent='Enter both origin coordinates, or leave both empty.';return}
  const mode=tripRouteMode.value;
  if(mode==='REPLAY_ONLY'&&!assignmentPreview){message.textContent='Android GPS 경로를 먼저 받아야 합니다.';return}
  const body={vehicleId:value('trip-vehicle'),routeMode:mode,tripStatus:'READY'};
  if(mode==='REPLAY_ONLY'&&assignmentPreview)body.replayPreviewId=String(assignmentPreview.replayPreviewId);
  if(mode==='DUAL'){
    body.destinationName=value('trip-destination-name');
    body.destinationLatitude=Number(value('trip-destination-latitude'));
    body.destinationLongitude=Number(value('trip-destination-longitude'));
  }
  for(const [field,id] of [['originName','trip-origin-name'],['destinationAddress','trip-destination-address']])if(value(id))body[field]=value(id);
  if(originLatitude){body.originLatitude=Number(originLatitude);body.originLongitude=Number(originLongitude)}
  if(value('trip-planned-start'))body.plannedStartAt=new Date(value('trip-planned-start')).toISOString();
  button.disabled=true;message.textContent='Creating trip…';
  try{
    const trip=await api('/api/v1/trips',{method:'POST',body:JSON.stringify(body)},true);
    message.textContent=`Trip ID ${trip.tripId} 배정 완료 · Android에서 운행 시작을 누르세요.`;
    document.querySelector('#recording-trip-id').value=String(trip.tripId);
    await Promise.all([loadTripAssignments(),loadTripRecordings(String(trip.tripId)),refresh()]);
  }catch(ex){message.textContent=ex.message}
  finally{button.disabled=false;form.querySelector('#trip-destination-name').focus()}
});
async function boot(){
  if(token){
    demoMode=false;
    try{const auth=await api('/api/v1/auth/me',{},true);await start(auth.role);return}catch{token=null;sessionStorage.removeItem('itsToken')}
  }
  if(await autoLogin()){
    demoMode=false;
    try{const auth=await api('/api/v1/auth/me',{},true);await start(auth.role);return}catch{token=null;sessionStorage.removeItem('itsToken')}
  }
  demoMode=true;
  try{await start()}catch(ex){demoMode=false;document.querySelector('#login').hidden=false;document.querySelector('#connection').textContent='로그인 대기';error.textContent=ex.message}
}
boot().catch(e=>error.textContent=e.message);
