import {uiText, initializeDashboard, renderVehicleDetails, vehicleIcon, TRIP_STATUS_LABELS, formatSpeed} from './dashboard-ui.js?v=5';
import {fleetPosition, createFleetViewport} from './fleet-view.js';
import {buildReplayTimeline,detectionSampleAtPts,entryForTime} from './replay-timeline.js';
import {acceptLiveTelemetry,applyLiveTelemetry,createLiveView,describeLiveTelemetry,isLiveOverride,LIVE_OVERRIDE_STALE_MS,resetLiveFrameOrder} from './live-telemetry.js?v=2';
import {cancelGlide,createAndroidMarkerRevealer,createLiveMapFollower,fleetMarkerStyle,glideMarker,isAndroidGpsItem,LIVE_MARKER_STYLE} from './live-map.js?v=2';
import {FOREGROUND_RESUME_MESSAGE,installForegroundResume} from './foreground-resume.js';
import {estimatedReplayTimestamp,recordingGapAt,recordingGapThresholdS,forwardOnlyPosition,plannedProgress,recordedProgress,matchedRoutePosition,replayClock,replayProgressOnRoute,replayRouteLine,remainingRoute,routeDisplayFromPosition,SNAP_SEARCH_AHEAD_M,tripTimes} from './trip-route-ui.js?v=13';
import {installPanelDrag} from './panel-drag.js';
import {describeDetections} from './detection-status.js';
import {installOperatorBasemap} from './operator-basemap.js?v=6';
import {initializeAssistantPanel} from './assistant-panel.js?v=4';
import {deleteRecordingSnapshot} from './recording-delete.js?v=1';
import {deleteTripWithRecordings,tripAction} from './trip-actions.js?v=1';
const map=L.map('map',{touchZoom:true}).setView([35.1796,129.0756],12);
const mapContainer=map.getContainer();
let rightButtonPan=null;
let leftButtonPan=null;
const touchPresses=new Map();
let touchMenuTimer=0;
let touchMenuPointerId=null;
let touchContextMenuOpened=false;
const cancelTouchMenu=()=>{
  if(touchMenuTimer)window.clearTimeout(touchMenuTimer);
  touchMenuTimer=0;
  touchMenuPointerId=null;
};
mapContainer.addEventListener('pointerdown',event=>{
  if(event.pointerType!=='touch')return;
  if(event.target.closest('.leaflet-control,.virtual-route-context-menu,.virtual-routing-log'))return;
  if(!event.target.closest('.virtual-point-icon')&&window.__operatorTouchRoadBrushPointerDown?.(event)){
    cancelTouchMenu();
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  touchPresses.set(event.pointerId,{x:event.clientX,y:event.clientY});
  // A second finger means this is a map gesture (usually pinch zoom), not a
  // request for the right-click menu.
  if(touchPresses.size!==1){cancelTouchMenu();return;}
  if(event.target.closest('.leaflet-control,.virtual-route-context-menu,.virtual-routing-log'))return;
  touchMenuPointerId=event.pointerId;
  touchMenuTimer=window.setTimeout(()=>{
    const point=touchPresses.get(event.pointerId);
    if(!point||touchPresses.size!==1)return;
    touchMenuTimer=0;
    touchMenuPointerId=null;
    touchContextMenuOpened=true;
    mapContainer.dispatchEvent(new CustomEvent('operator-map-contextrequest',{
      detail:{clientX:point.x,clientY:point.y,touch:true},
    }));
  },550);
});
mapContainer.addEventListener('pointermove',event=>{
  if(event.pointerType!=='touch')return;
  const point=touchPresses.get(event.pointerId);
  if(!point)return;
  if(Math.hypot(event.clientX-point.x,event.clientY-point.y)>10&&touchMenuPointerId===event.pointerId)cancelTouchMenu();
});
const finishTouchPress=event=>{
  if(event.pointerType!=='touch')return;
  touchPresses.delete(event.pointerId);
  if(touchMenuPointerId===event.pointerId)cancelTouchMenu();
  if(touchContextMenuOpened){
    touchContextMenuOpened=false;
    map.once('click',clickEvent=>L.DomEvent.stop(clickEvent));
  }
};
mapContainer.addEventListener('pointerup',finishTouchPress);
mapContainer.addEventListener('pointercancel',finishTouchPress);
mapContainer.addEventListener('operator-map-contextrequest',event=>{
  if(event.detail?.touch)touchContextMenuOpened=true;
});
mapContainer.addEventListener('mousedown',event=>{
  // Chromium emits compatibility mouse events after touch input. Leave those
  // to Leaflet so touch taps and pinch gestures are not treated as mouse pans.
  if(event.sourceCapabilities?.firesTouchEvents)return;
  if(event.target.closest('.leaflet-control,.virtual-route-context-menu,.virtual-routing-log'))return;
  if(event.target.closest('.virtual-point-icon'))return;
  if(window.__operatorRoadBrushPointerDown?.(event)){event.preventDefault();event.stopImmediatePropagation();return;}
  if(event.button===0){
    if(window.__operatorPointPlacementActive?.()){event.preventDefault();event.stopPropagation();return;}
    event.preventDefault();event.stopPropagation();
    leftButtonPan={x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,moved:false};
    mapContainer.classList.add('left-button-panning');
    return;
  }
  if(event.button!==2)return;
  event.preventDefault();
  event.stopPropagation();
  rightButtonPan={x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,moved:false};
  mapContainer.classList.add('right-button-panning');
},true);
mapContainer.addEventListener('contextmenu',event=>event.preventDefault());
document.addEventListener('mousemove',event=>{
  const pan=rightButtonPan||leftButtonPan;
  if(!pan)return;
  const dx=event.clientX-pan.x,dy=event.clientY-pan.y;
  if(!pan.moved&&Math.hypot(event.clientX-pan.startX,event.clientY-pan.startY)>5){
    pan.moved=true;
    pauseLiveMapForManualPan();
  }
  pan.x=event.clientX;
  pan.y=event.clientY;
  if(dx||dy)map.panBy([-dx,-dy],{animate:false});
});
document.addEventListener('mouseup',event=>{
  if(event.button===0&&leftButtonPan){
    const wasDrag=leftButtonPan.moved;
    leftButtonPan=null;
    mapContainer.classList.remove('left-button-panning');
    if(wasDrag)map.once('click',event=>L.DomEvent.stop(event));
    return;
  }
  if(event.button===2&&rightButtonPan){
    const wasClick=!rightButtonPan.moved;
    rightButtonPan=null;
    mapContainer.classList.remove('right-button-panning');
    if(wasClick)mapContainer.dispatchEvent(new CustomEvent('operator-map-contextrequest',{detail:{clientX:event.clientX,clientY:event.clientY}}));
  }
});
window.addEventListener('blur',()=>{
  rightButtonPan=null;
  leftButtonPan=null;
  mapContainer.classList.remove('right-button-panning');
  mapContainer.classList.remove('left-button-panning');
});
window.__operatorMap=map;
const fleetViewport=createFleetViewport(map);
const fallbackBasemap=L.tileLayer('/osm/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap contributors'}).addTo(map);
const mapStyleSelect=document.querySelector('#map-style');
const savedMapStyle=localStorage.getItem('operatorMapStyle');
mapStyleSelect.value=savedMapStyle==='default'?'default':'operator';
const setMapStyle=installOperatorBasemap(map,fallbackBasemap,mapStyleSelect.value);
mapStyleSelect.addEventListener('change',()=>{
  localStorage.setItem('operatorMapStyle',mapStyleSelect.value);
  setMapStyle(mapStyleSelect.value);
});
const markers=new Map(),tripMapMarkers=new Map();let token=sessionStorage.getItem('itsToken');let bootstrap;let selected;let routeLayer;let replayRouteLayer;let destinationMarker;let displayedRouteKey='';let currentTripDisplay=null;let currentRouteCoordinates=null;let currentRouteTiming=null;let currentRouteBreaks=[];let routePosition=0;let shownRoutePosition=null;let routeAnimationFrame=0;let displayRequest=0;let latestFleet=[];let assignmentPreview=null;let assignmentPreviewVehicleId='';let activeTripByVehicle=new Map();let demoMode=false;let currentRole='';let recordingsRequest=0;let refreshTimer;let telemetryModeTimer;let tripListTimer;let tripMapPick;let replayTimeline=[];let tripRecordingVideos=[];let recordingDeleteBusy=false;let replayDuration=0;let replayIndex=-1;let replayGeneration=0;let replayTripId='';let recordingDeleteRange=null;let recordingDeleteDrag=null;let replayScrubbing=false;let replayScrubWasPlaying=false;let replaySeekGeneration=0;let replaySeekPending=false;let liveView=null;let lastLiveMessage=null;let liveStatusTimer;
// The default Leaflet renderer clips paths close to the viewport. A wider
// drawing area keeps the remaining route visible immediately while dragging.
const tripRouteRenderer=L.svg({padding:3});
const tripRouteStyle={renderer:tripRouteRenderer,color:'#0878f9',weight:10,opacity:0.58,lineCap:'round',lineJoin:'round',interactive:false,className:'trip-route-pulse'};
const error=document.querySelector('#error'),details=document.querySelector('#details'),fields=document.querySelector('#fields');
const operatorLayout=document.querySelector('#operator-layout');
const livePanel=document.querySelector('#live-view-panel'),liveFrame=document.querySelector('#live-view-frame'),liveRecenterButton=document.querySelector('#live-recenter');
// Debugging details (diagnostics, telemetry status, the Vision page's controls)
// are hidden by default and one click away; the choice is remembered.
// The live preview is docked in the "실시간 영상" tab unless the operator floats it on the map.
let liveDocked=(()=>{try{return localStorage.getItem('operatorLivePanelDocked')!=='false'}catch{return true}})();
const liveDock=document.querySelector('#live-view-dock');
// Details (diagnostics, telemetry status, the Vision page's information and
// options) are a fullscreen-only view: "상세 보기" appears only in fullscreen,
// and leaving fullscreen returns to video only.
let liveFullscreenDetails=false;
let liveDetailsHidden=true;
function syncLiveDetails(){
  liveDetailsHidden=!(liveFullscreenDetails&&document.fullscreenElement===livePanel);
  livePanel.classList.toggle('details-hidden',liveDetailsHidden);
  const button=document.querySelector('#live-details');
  button.textContent=liveDetailsHidden?'상세 보기':'상세 숨기기';
  button.setAttribute('aria-pressed',String(!liveDetailsHidden));
  notifyLiveFrameFullscreen();
  fitLivePanelToVideo();
}
// In video-only mode the panel takes the video's exact shape, so there are no
// black bars; its desktop size follows the viewport and its mobile size uses
// the available map width. With details shown, the stylesheet size applies.
let liveVideoSize=null;
const LIVE_PANEL_INSET=8; // matches the video's side margins in styles.css
const LIVE_PANEL_FOOTER=30; // the detection status row under the video
function fitLivePanelToVideo(){
  if(livePanel.hidden||document.fullscreenElement===livePanel){livePanel.style.removeProperty('width');livePanel.style.removeProperty('height');livePanelDrag?.apply();return}
  const header=48,inset=LIVE_PANEL_INSET,footer=LIVE_PANEL_FOOTER,detailRows=50;
  const ratio=liveVideoSize?liveVideoSize.width/liveVideoSize.height:16/9;
  if(liveDocked){
    // Docked: take the sidebar's width and the video's shape (16:9 until it is known).
    const width=liveDock.clientWidth||320;
    const videoHeight=(width-(liveDetailsHidden?2*inset:0))/ratio;
    const height=liveDetailsHidden?header+videoHeight+footer:header+detailRows+Math.max(videoHeight,360)+footer;
    livePanel.style.width='100%';livePanel.style.height=`${Math.round(height)}px`;
    return;
  }
  const fit=liveDetailsHidden&&liveVideoSize;
  if(!fit){livePanel.style.removeProperty('width');livePanel.style.removeProperty('height')}
  else{
    const surface=document.querySelector('#map-surface').getBoundingClientRect();
    const maxPanelWidth=window.innerWidth<=767
      ?Math.min(surface.width-24,window.innerWidth-24)
      :Math.min(460,window.innerWidth*0.22,surface.width-36);
    let videoWidth=Math.max(160,maxPanelWidth)-2*inset,videoHeight=videoWidth/ratio;
    const maxVideoHeight=Math.max(90,Math.min(360,window.innerHeight*0.36,surface.height-36,surface.height*0.7)-header-footer);
    if(videoHeight>maxVideoHeight){videoHeight=maxVideoHeight;videoWidth=videoHeight*ratio}
    livePanel.style.width=`${Math.round(videoWidth+2*inset)}px`;livePanel.style.height=`${Math.round(header+videoHeight+footer)}px`;
  }
  livePanelDrag?.apply();
}
// Moves the single live panel between the sidebar tab and the map. moveBefore()
// keeps the iframe's video connection alive where the browser supports it;
// elsewhere the move reloads the Vision page, which reconnects by itself.
// Docked in the sidebar the card already says what this is, so the title is just
// the vehicle; floating on the map it keeps the "실시간 영상" prefix.
function updateLiveTitle(){
  if(!liveView)return;
  const label=liveTargetLabel(liveView.item);
  document.querySelector('#live-view-title').textContent=liveDocked?label:`실시간 영상 · ${label}`;
}
function placeLivePanel(docked){
  liveDocked=docked;
  try{localStorage.setItem('operatorLivePanelDocked',String(docked))}catch{}
  const host=docked?liveDock:document.querySelector('#map-surface');
  if(livePanel.parentElement!==host){
    if(typeof host.moveBefore==='function'){try{host.moveBefore(livePanel,null)}catch{host.appendChild(livePanel)}}
    else host.appendChild(livePanel);
  }
  livePanel.classList.toggle('docked',docked);
  if(docked)for(const side of ['left','top','right','bottom'])livePanel.style.removeProperty(side);
  operatorLayout.classList.toggle('live-view-open',!docked&&!livePanel.hidden);
  document.querySelector('#live-float').textContent=docked?'지도에 띄우기':'사이드바에 고정';
  updateLiveTitle();
  fitLivePanelToVideo();
  refreshMapLayout();
}
document.querySelector('#live-details').addEventListener('click',()=>{
  liveFullscreenDetails=!liveFullscreenDetails;
  syncLiveDetails();
});
// Drag the live preview by its title bar anywhere inside the map.
const livePanelDrag=installPanelDrag({panel:livePanel,handle:livePanel.querySelector('.live-view-header'),container:document.querySelector('#map-surface'),storage:(()=>{try{return localStorage}catch{return null}})(),storageKey:'operatorLivePanelPosition',enabled:()=>!liveDocked});
// Declared above the drag helper it calls, so it runs only once that exists.
syncLiveDetails();
const livePanelResize=new ResizeObserver(()=>fitLivePanelToVideo());
livePanelResize.observe(document.querySelector('#map-surface'));livePanelResize.observe(liveDock);
// In fullscreen the panel is the fullscreen element and cannot be moved;
// leave fullscreen first, then dock or float it.
document.querySelector('#live-float').addEventListener('click',async()=>{
  if(document.fullscreenElement===livePanel)await document.exitFullscreen().catch(()=>{});
  placeLivePanel(!liveDocked);
});
// A docked preview is hidden by the saved-recordings tab; close it rather than keep a TURN port busy.
document.querySelector('#recording-saved-tab').addEventListener('click',()=>{if(liveView&&liveDocked)stopLiveView()});
placeLivePanel(liveDocked);
const ROUTE_TICK_MS=500,FLEET_POLL_MS=3000;
// How the replay line uses the road match: 'gaps' (default) follows the
// recorded GPS and uses the road only across GPS gaps; 'always' snaps the
// whole line to the road. Remembered per browser.
const roadSnapSelect=document.querySelector('#road-snap-mode');
let roadSnapMode=(()=>{try{return localStorage.getItem('operatorRoadSnapMode')==='always'?'always':'gaps'}catch{return 'gaps'}})();
roadSnapSelect.value=roadSnapMode;
roadSnapSelect.addEventListener('change',()=>{
  roadSnapMode=roadSnapSelect.value==='always'?'always':'gaps';
  try{localStorage.setItem('operatorRoadSnapMode',roadSnapMode)}catch{}
  if(currentTripDisplay)showTripDisplay(currentTripDisplay);
});
// The recorded GPS position trails the camera clock (about 0.25-0.3 s on the
// 2026-08-27 recording, from gyro vs GPS turn rate), so a replay vehicle placed
// at the frame's own time sits a few metres behind the footage. Place it this
// much later on the recording. Remembered per browser.
const DEFAULT_REPLAY_GPS_LEAD_MS=300;
const replayGpsLeadInput=document.querySelector('#replay-gps-lead');
const clampLeadMs=value=>Number.isFinite(value)?Math.max(-2000,Math.min(3000,Math.round(value))):DEFAULT_REPLAY_GPS_LEAD_MS;
let replayGpsLeadMs=(()=>{try{const saved=localStorage.getItem('operatorReplayGpsLeadMs');return saved==null?DEFAULT_REPLAY_GPS_LEAD_MS:clampLeadMs(Number(saved))}catch{return DEFAULT_REPLAY_GPS_LEAD_MS}})();
replayGpsLeadInput.value=String(replayGpsLeadMs);
replayGpsLeadInput.addEventListener('change',()=>{
  replayGpsLeadMs=clampLeadMs(Number(replayGpsLeadInput.value));replayGpsLeadInput.value=String(replayGpsLeadMs);
  try{localStorage.setItem('operatorReplayGpsLeadMs',String(replayGpsLeadMs))}catch{}
});
function withReplayGpsLead(timestampNs){
  if(timestampNs==null||!/^\d+$/.test(String(timestampNs)))return timestampNs;
  return (BigInt(timestampNs)+BigInt(replayGpsLeadMs)*1_000_000n).toString();
}
// Replacing a divIcon rebuilds its HTML and restarts the pulse animation, so
// only replace it when it actually looks different.
function setMarkerIcon(entry,icon){
  const key=`${icon.options.className}|${icon.options.html}`;
  if(entry.iconKey===key)return;
  entry.iconKey=key;entry.marker.setIcon(icon);
}
// The replay vehicle's marker is placed on its trip line by the route update.
function routeControlsMarker(item){
  return currentTripDisplay?.routeMode==='REPLAY_ONLY'&&Array.isArray(currentRouteCoordinates)
    &&String(item?.vehicleId)===String(currentTripDisplay.vehicleId)&&item?.telemetry?.telemetry_source==='RECORDED_GPS';
}
// Both "선택 차량" cards (empty state and details) carry a vehicle picker.
// Choosing a vehicle selects it and centres the map on it, two levels below
// the map's closest zoom.
const vehiclePickers=[...document.querySelectorAll('.vehicle-picker')];
let vehiclePickerSignature='';
function vehiclePickerLabel(item){
  const t=item.telemetry||{},name=item.vehicleCode||item.vehicleName||t.external_id;
  return t.telemetry_source!=='RECORDED_GPS'&&isAndroidGpsItem(item)?`${name} · Android GPS`:name;
}
function renderVehiclePickers(vehicles){
  const options=vehicles.filter(item=>item.telemetry?.external_id&&fleetPosition(item))
    .map(item=>({value:item.telemetry.external_id,label:vehiclePickerLabel(item)}))
    .sort((a,b)=>a.label.localeCompare(b.label,'ko'));
  const signature=JSON.stringify(options);
  if(signature!==vehiclePickerSignature){
    vehiclePickerSignature=signature;
    for(const picker of vehiclePickers){
      picker.replaceChildren(new Option(options.length?'차량 선택':'표시할 차량 없음',''));
      picker.options[0].disabled=true;
      for(const option of options)picker.add(new Option(option.label,option.value));
    }
  }
  syncVehiclePickers();
}
function syncVehiclePickers(){
  const key=selected?.telemetry?.external_id||'';
  for(const picker of vehiclePickers)picker.value=[...picker.options].some(option=>option.value===key)?key:'';
}
for(const picker of vehiclePickers)picker.addEventListener('change',()=>{
  const item=latestFleet.find(vehicle=>vehicle.telemetry?.external_id===picker.value),position=item&&fleetPosition(item);
  if(!position)return;
  selectVehicle(item);
  const maxZoom=Number.isFinite(map.getMaxZoom())?map.getMaxZoom():18;
  map.setView(position,Math.max(map.getMinZoom(),maxZoom-2));
});
function createMarkerEntry(item,position,{liveOnly=false}={}){
  const marker=L.marker(position,{icon:vehicleIcon(item,liveOnly,false,matchesLiveTarget(item)),zIndexOffset:liveOnly?1000:0}).addTo(map);
  const icon=marker.options.icon;
  const entry={marker,item,liveOnly,labelOnTrip:null,iconKey:icon?.options?`${icon.options.className}|${icon.options.html}`:null};
  marker.on('click',()=>selectVehicle(entry.item));
  syncVehicleMapLabel(entry);
  if(item?.telemetry?.external_id)markers.set(item.telemetry.external_id,entry);
  return entry;
}
function syncVehicleMapLabel(entry){
  const item=entry.item,telemetry=item?.telemetry||{},onTrip=item?.tripStatus==='IN_PROGRESS';
  const name=telemetry.telemetry_source==='RECORDED_GPS'?(item?.vehicleCode||'차량'):isAndroidGpsItem(item)?`Android GPS · ${item?.vehicleCode||telemetry.external_id||'차량'}`:item?.vehicleCode||telemetry.external_id||'차량';
  const label=document.createElement('span');label.textContent=entry.estimated?`${name} · 추정 위치`:name;
  if(entry.labelOnTrip!==onTrip){
    entry.marker.unbindTooltip();
    entry.marker.bindTooltip(label,{direction:'top',permanent:onTrip,offset:[0,-14],className:`vehicle-label${onTrip?' vehicle-label--trip':''}`,interactive:false});
    entry.labelOnTrip=onTrip;
  }else entry.marker.setTooltipContent(label);
}
// Every normal-monitoring layer on the map. All three are cached and only
// added to the map when first created, so whoever takes the map away has to
// put them back: render() reuses a cached marker rather than recreating it, so
// a detached marker would never reappear for the rest of the session.
function normalMapLayers(){
  return [...markers.values()].map(entry=>entry.marker)
    .concat([...tripMapMarkers.values()],[routeLayer,replayRouteLayer,destinationMarker].filter(Boolean));
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
function pauseLiveMapForManualPan(){
  if(!liveMapFollower.isFollowing())return;
  liveMapFollower.pause();
  map.stop();
}
map.on('dragstart',pauseLiveMapForManualPan);
// Pause before Leaflet starts the touch gesture: incoming live positions can
// otherwise restart its pan animation while the finger is trying to drag.
mapContainer.addEventListener('pointerdown',event=>{
  if(event.pointerType!=='touch'||event.target.closest('.leaflet-control,.virtual-route-context-menu,.virtual-routing-log'))return;
  pauseLiveMapForManualPan();
},true);
// Leaflet switches to the new zoom's projection as soon as its zoom animation
// starts, while the route SVG is still being scaled from the old zoom: a path
// redrawn meanwhile lands out of place, apart from the vehicle, until the zoom
// ends. Route redraws wait for zoomend; the latest one per layer is applied then.
let mapZooming=false;const deferredRouteDraws=new Map();
map.on('zoomstart',()=>{mapZooming=true});
map.on('zoomend',()=>{
  mapZooming=false;
  const draws=[...deferredRouteDraws.values()];deferredRouteDraws.clear();
  for(const draw of draws)draw();
});
function drawWhenNotZooming(key,draw){
  if(mapZooming)deferredRouteDraws.set(key,draw);else draw();
}
function refreshMapLayout(){requestAnimationFrame(()=>map.invalidateSize({pan:false}));}
new ResizeObserver(refreshMapLayout).observe(document.querySelector('#map-surface'));
const dashboard=initializeDashboard({map,markers,selectVehicle,showFleet:items=>fleetViewport.fit(items)});
initializeAssistantPanel({getToken:()=>token,getScope:assistantScope,getTargets:assistantTargets});
// What the assistant answers about: the selected real vehicle in monitoring
// mode, or the scenario/virtual vehicle selection in virtual mode.
// Everything the operator can point the assistant at instead: every real
// vehicle on the map, plus virtual scenarios and vehicles once loaded.
function assistantTargets(){
  const seen=new Set(),real=[];
  for(const {item} of markers.values()){
    if(item?.vehicleId==null||item.vehicleSource==='VIRTUAL'||seen.has(String(item.vehicleId)))continue;
    seen.add(String(item.vehicleId));
    const name=liveTargetLabel(item);
    real.push({value:`real:${item.vehicleId}`,text:name,label:`실차량 ${name}`,scope:{view:'monitoring',vehicleId:String(item.vehicleId)}});
  }
  real.sort((a,b)=>a.text.localeCompare(b.text,'ko'));
  return[{label:'실차량',options:real},...(window.__virtualAssistantTargets?.()??[])];
}
function assistantScope(){
  if(window.__virtualMode)return window.__virtualAssistantScope?.()??{scope:{view:'virtual'},label:'가상 시나리오 전체'};
  if(selected?.vehicleId==null)return{scope:{view:'monitoring'},label:'실차량 전체'};
  return{scope:{view:'monitoring',vehicleId:String(selected.vehicleId)},label:`실차량 ${liveTargetLabel(selected)}`};
}
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
// Live View opens by itself on selection (or from the "실시간 영상" tab); this
// only tells the operator whether the selected vehicle can be watched.
function syncLiveViewButton(item=selected){
  const available=Boolean(bootstrap)&&matchesLiveTarget(item);
  document.querySelector('#recording-live-status').textContent=available
    ?(liveView?'':'선택 차량의 실시간 영상 연결 가능 · 실시간 영상 탭을 누르면 다시 열립니다')
    :'실시간 영상을 보내는 차량을 선택하세요.';
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
// frame. It is used whenever details are hidden; with fullscreen details on,
// the page shows its full information and options.
function notifyLiveFrameFullscreen(fullscreen=liveDetailsHidden){
  if(!liveView)return;
  // showFps: the Vision page's FPS counter is only for the real fullscreen view.
  liveFrame.contentWindow?.postMessage({type:'operator-live-view-fullscreen',fullscreen,showFps:document.fullscreenElement===livePanel},liveView.frameOrigin);
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
  updateLiveTitle();
  renderLiveTelemetryStatus();
}
// The progress card's red end flag frames the vehicle and the trip's destination
// together, clear of the controls over the map (with its own destination
// marker, as a trip that has not started draws no route), and keeps both in
// view as the vehicle moves. The vehicle
// stays live throughout. The vehicle icon on the bar, dragging the map or
// recentring Live View returns to following the vehicle.
let destinationPeekMarker=null,destinationFrame=null;
function clearDestinationPeek(){
  destinationFrame=null;
  if(destinationPeekMarker){map.removeLayer(destinationPeekMarker);destinationPeekMarker=null}
}
function tripDestination(display){
  const coordinates=display?.routeMode==='REPLAY_ONLY'
    ?display.replayPreview?.roadMatch?.routeGeojson?.coordinates??display.replayPreview?.points?.map(point=>[point[1],point[2]])
    :display?.plannedRoute?.routeGeojson?.coordinates;
  const end=Array.isArray(coordinates)?coordinates.at(-1):null;
  return Array.isArray(end)&&Number.isFinite(end[0])&&Number.isFinite(end[1])?[end[1],end[0]]:null;
}
function framedVehiclePosition(){
  return markers.get(liveView?.markerKey??selected?.telemetry?.external_id)?.marker?.getLatLng()??null;
}
// Map space left clear of the controls drawn over it (search and filters, the
// legend, a floating Live View, Leaflet's controls): padding per side, in px.
// Each overlay pads the side that costs less of the map - a tall corner panel
// its left or right edge, a wide bar its top or bottom edge.
function mapOverlayPadding(){
  const box=map.getContainer().getBoundingClientRect(),width=box.width,height=box.height;
  const padding={top:16,right:16,bottom:16,left:16};
  for(const element of document.querySelectorAll('#map-commands,#map-legend,#map-pick-banner,#live-view-panel,.leaflet-control-container .leaflet-control')){
    if(element.hidden||!element.offsetParent)continue;
    const rect=element.getBoundingClientRect();
    const left=Math.max(0,rect.left-box.left),right=Math.min(width,rect.right-box.left);
    const top=Math.max(0,rect.top-box.top),bottom=Math.min(height,rect.bottom-box.top);
    if(right-left<2||bottom-top<2)continue;
    const horizontalSide=left<width-right?'left':'right',horizontal=horizontalSide==='left'?right:width-left;
    const verticalSide=top<height-bottom?'top':'bottom',vertical=verticalSide==='top'?bottom:height-top;
    if(horizontal/width<=vertical/height)padding[horizontalSide]=Math.max(padding[horizontalSide],horizontal+12);
    else padding[verticalSide]=Math.max(padding[verticalSide],vertical+12);
  }
  // Never leave less than 40% of the map for the view itself.
  for(const [a,b,size] of [['left','right',width],['top','bottom',height]]){
    const total=padding[a]+padding[b],limit=size*0.6;
    if(total>limit){padding[a]*=limit/total;padding[b]*=limit/total}
  }
  return padding;
}
// Keeps the vehicle and the destination in the part of the map no control
// covers. It refits only when either point leaves that clear area, so the zoom
// does not change on every position update.
function frameVehicleAndDestination(force=false){
  if(!destinationFrame)return;
  const vehicle=framedVehiclePosition();
  if(!vehicle)return;
  const padding=mapOverlayPadding(),size=map.getSize();
  padding.top+=36; // the destination's label sits above its marker
  const clear=point=>{const p=map.latLngToContainerPoint(point);
    return p.x>=padding.left-4&&p.x<=size.x-padding.right+4&&p.y>=padding.top-4&&p.y<=size.y-padding.bottom+4};
  if(!force&&clear(vehicle)&&clear(destinationFrame.target))return;
  map.fitBounds(L.latLngBounds([vehicle,destinationFrame.target]),
    {paddingTopLeft:[padding.left,padding.top],paddingBottomRight:[padding.right,padding.bottom],maxZoom:17});
}
function showTripDestination(){
  const target=tripDestination(currentTripDisplay);
  if(!target)return;
  liveMapFollower.pause();
  clearDestinationPeek();
  destinationPeekMarker=L.circleMarker(target,{radius:9,color:'#fff',weight:2,fillColor:'#e53955',fillOpacity:1}).addTo(map)
    .bindTooltip(`목적지 · ${currentTripDisplay.destinationName||'—'}`,{direction:'top',permanent:true});
  destinationFrame={target:L.latLng(target)};
  frameVehicleAndDestination(true);
}
function returnToVehicle(){
  clearDestinationPeek();
  if(liveView&&String(liveView.vehicleId)===String(currentTripDisplay?.vehicleId)){liveMapFollower.recenter();return}
  const vehicle=framedVehiclePosition();
  if(vehicle)map.setView(vehicle,Math.max(map.getZoom(),16));
}
setInterval(()=>{
  if(!destinationFrame||document.hidden||mapZooming)return;
  // Live View's own recenter button resumed following: it owns the camera again.
  if(liveMapFollower.isFollowing()){clearDestinationPeek();return}
  frameVehicleAndDestination();
},500);
map.on('dragstart',()=>{if(destinationFrame)destinationFrame=null});
for(const [id,action] of [['#selected-destination',showTripDestination],['#trip-track-vehicle',returnToVehicle]]){
  const element=document.querySelector(id);
  element.addEventListener('click',action);
  element.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();action()}});
}
function clearTripLayers(){
  clearDestinationPeek();
  for(const layer of [routeLayer,replayRouteLayer,destinationMarker])if(layer)map.removeLayer(layer);
  routeLayer=null;replayRouteLayer=null;destinationMarker=null;displayedRouteKey='';currentTripDisplay=null;currentRouteCoordinates=null;currentRouteTiming=null;currentRouteBreaks=[];routePosition=0;shownRoutePosition=null;cancelAnimationFrame(routeAnimationFrame);
  for(const entry of markers.values())if(entry.estimated){entry.estimated=false;entry.freeEstimated=false;syncVehicleMapLabel(entry)}
}
// Source time of the frame the live view last painted, while it is fresh.
let lastLiveMessageAt=0;
function presentedFrameTime(){
  if(!lastLiveMessage||Date.now()-lastLiveMessageAt>LIVE_OVERRIDE_STALE_MS)return null;
  const time=String(lastLiveMessage.telemetry?.source_timestamp_ns??lastLiveMessage.sourceTimestampNs??'');
  return /^\d+$/.test(time)?time:null;
}
// A GPS replay stream without a running trip follows its fixes, but where the
// recording has none (a tunnel) the phone streams placeholder fixes (frozen,
// then network) and nothing else. Its latest uploaded path (never drawn) places
// the vehicle through such gaps by the replay time, labelled "추정 위치".
let freeReplay=null,freeReplayLoading=null;
function freeReplayWanted(item){
  return item?.telemetry?.telemetry_source==='RECORDED_GPS'&&item?.tripStatus!=='IN_PROGRESS';
}
function ensureFreeReplay(vehicleId){
  if(!vehicleId)return;
  const fresh=freeReplay&&String(freeReplay.vehicleId)===String(vehicleId)&&Date.now()-freeReplay.loadedAt<60000;
  if(fresh||freeReplayLoading===String(vehicleId))return;
  freeReplayLoading=String(vehicleId);
  void api(`/api/v1/trips/vehicles/${vehicleId}/replay-preview`,{},true).then(preview=>{
    const line=preview?replayRouteLine(preview,roadSnapMode):null;
    freeReplay=line?.timing?{vehicleId:String(vehicleId),points:preview.points,line,gapS:recordingGapThresholdS(preview.points),loadedAt:Date.now()}
      :{vehicleId:String(vehicleId),points:null,line:null,loadedAt:Date.now()};
  }).catch(()=>{}).finally(()=>{if(freeReplayLoading===String(vehicleId))freeReplayLoading=null});
}
// Where the uploaded path puts vehicleId at a replay time; null outside it.
function freeReplayEstimate(vehicleId,timestampNs){
  const replay=freeReplay;
  if(!replay?.line||String(replay.vehicleId)!==String(vehicleId)||timestampNs==null||!/^\d+$/.test(String(timestampNs)))return null;
  const time=withReplayGpsLead(String(timestampNs)),points=replay.points;
  if(!Array.isArray(points)||BigInt(time)<BigInt(points[0][0])||BigInt(time)>BigInt(points.at(-1)[0]))return null;
  const position=matchedRoutePosition(replay.line.timing.anchors,time,replay.line.timing.distances);
  const head=position==null?null:routeDisplayFromPosition(replay.line.coordinates,position,replay.line.breaks)?.head;
  return head?{latLng:head,inGap:recordingGapAt(points,time,replay.gapS)}:null;
}
// The stream's current replay time: the phone's replay clock advanced by the
// time since it was reported (the recording plays in real time), at most 45 s.
function streamReplayTime(item){
  const metadata=item?.telemetry?.source_metadata,clock=replayClock(metadata);
  const time=clock?.time??metadata?.sourceTimestampNs,at=clock?clock.at:metadata?.receivedAt;
  if(time==null||!/^\d+$/.test(String(time)))return null;
  const age=Date.now()-new Date(at??'').getTime();
  return Number.isFinite(age)&&age>0?(BigInt(time)+BigInt(Math.round(Math.min(age,45000)*1e6))).toString():String(time);
}
function setFreeEstimated(entry,value){
  if(!entry||Boolean(entry.freeEstimated)===value)return;
  entry.freeEstimated=value;entry.estimated=value;syncVehicleMapLabel(entry);
}
function updateRemainingTripRoute(fixOverride=null,sourceTimeOverride=null){
  const display=currentTripDisplay,layer=routeLayer||replayRouteLayer;
  window.__replayDebug={at:new Date().toISOString(),stage:!display?'no trip shown':!layer?'no route layer':'placing',
    tripId:display?.tripId??null,routeMode:display?.routeMode??null,tripStatus:display?.tripStatus??null,
    liveViewVehicle:liveView?.vehicleId??null,tripVehicle:display?.vehicleId??null};
  if(!display||!layer)return;
  const replayOnly=display.routeMode==='REPLAY_ONLY';
  const candidates=latestFleet.filter(entry=>String(entry.vehicleId)===String(display.vehicleId));
  const selectedFix=candidates.find(entry=>entry.telemetry?.external_id===selected?.telemetry?.external_id);
  const item=replayOnly?candidates.find(entry=>entry.telemetry?.telemetry_source==='RECORDED_GPS')
    :selectedFix||candidates.find(entry=>entry.telemetry?.telemetry_source==='DEVICE_GPS')
      ||candidates.find(entry=>entry.telemetry?.telemetry_source==='RECORDED_GPS')
      ||candidates.find(entry=>entry.telemetry?.telemetry_source==='BIMS_LIVE'&&entry.telemetry?.source_metadata?.state==='live');
  const marker=item&&markers.get(item.telemetry?.external_id)?.marker;
  const liveGps=isLiveOverride(liveView,item?.telemetry?.external_id,Date.now())?lastLiveMessage?.telemetry?.gps:null;
  const fix=fixOverride||liveGps||item?.telemetry;
  const metadata=item?.telemetry?.source_metadata;
  // A replay trip's live view gives the painted frame's time even where the
  // recording has no GPS for it (a tunnel: "GPS stale"), so the vehicle keeps
  // moving with the footage instead of waiting on the phone's placeholder fixes.
  const liveSourceTime=liveGps?lastLiveMessage?.telemetry?.source_timestamp_ns
    :replayOnly&&String(liveView?.vehicleId)===String(display.vehicleId)?presentedFrameTime():null;
  // The replay clock from the phone's batches keeps advancing where the recording
  // has no GPS (a tunnel, an underground car park), so it places the vehicle by
  // how far the recording has actually played; the last fix is the fallback.
  const clock=replayOnly?replayClock(metadata):null;
  const sourceTime=sourceTimeOverride||liveSourceTime||clock?.time||metadata?.sourceTimestampNs||display.replayPosition?.sourceTimestampNs;
  const receivedAt=(sourceTimeOverride||liveSourceTime)?null
    :clock?clock.at:metadata?.sourceTimestampNs?metadata.receivedAt:display.replayPosition?.receivedAt;
  const estimatedTime=replayOnly&&display.tripStatus==='IN_PROGRESS'
    ?estimatedReplayTimestamp(sourceTime,receivedAt,Date.now(),Number(item?.telemetry?.speed_kmh)):null;
  // Replay: the recording's own time decides where on the line the vehicle is
  // (road-matched or the recorded line itself), never a nearest-segment search.
  const playbackPosition=replayOnly?matchedRoutePosition(currentRouteTiming?.anchors,withReplayGpsLead(estimatedTime||sourceTime),currentRouteTiming?.distances):null;
  // Read-only snapshot for diagnosing replay placement from the browser console
  // (copy(JSON.stringify(window.__replayDebug)) while the problem is visible).
  if(replayOnly){
    const points=display.replayPreview?.points,time=withReplayGpsLead(estimatedTime||sourceTime);
    let gapS=null;
    if(Array.isArray(points)&&time!=null){
      const after=points.findIndex(point=>BigInt(point[0])>BigInt(time));
      if(after>0)gapS=Number(BigInt(points[after][0])-BigInt(points[after-1][0]))/1e9;
    }
    window.__replayDebug={...window.__replayDebug,caller:sourceTimeOverride?'frame-with-gps':fixOverride?'fix':'tick-or-frame-without-gps',
      timeSource:sourceTimeOverride?'frame':liveSourceTime?(liveGps?'live-gps':'presented-frame'):clock?'replay-clock':metadata?.sourceTimestampNs?'last-fix':'trip-position',
      sourceTime,estimatedTime,placedTime:time,playbackPosition,routePosition,hasItem:Boolean(item),hasMarker:Boolean(marker),hasFix:Number.isFinite(fix?.latitude),
      liveFrameAgeMs:lastLiveMessageAt?Date.now()-lastLiveMessageAt:null,liveStatus:lastLiveMessage?.telemetry?.status??null,
      previewFingerprint:display.replayPreview?.fingerprint??null,previewPoints:Array.isArray(points)?points.length:null,previewGapAroundTimeS:gapS,
      lineAnchors:currentRouteTiming?.anchors?.length??null};
  }
  let remaining;
  if(playbackPosition!=null){
    remaining=remainingRoute(currentRouteCoordinates,fix,forwardOnlyPosition(routePosition,playbackPosition,currentRouteTiming?.distances),true,true);
  }else{
    // Real GPS on a planned route: search only a short way ahead, facing the heading.
    const speed=Number(item?.telemetry?.speed_kmh),heading=Number(fix?.heading_deg??fix?.bearing_deg??item?.telemetry?.heading_deg);
    remaining=remainingRoute(currentRouteCoordinates,fix,routePosition,replayOnly,false,
      {maxAheadM:SNAP_SEARCH_AHEAD_M,headingDeg:Number.isFinite(speed)&&speed>5&&Number.isFinite(heading)?heading:null});
  }
  // No current position yet (trip not started, phone not streaming): show the
  // whole route rather than nothing.
  if(!remaining){const latLngs=replayOnly?routeDisplayFromPosition(currentRouteCoordinates,0,currentRouteBreaks)?.latLngs??[]
    :Array.isArray(currentRouteCoordinates)?currentRouteCoordinates.map(([lon,lat])=>[lat,lon]):[];
    drawWhenNotZooming(layer,()=>layer.setLatLngs(latLngs));return}
  routePosition=remaining.position;
  if(replayOnly&&marker){
    // The route and marker use the same timed, road-aligned replay line.
    // A live-view time is the painted frame's own, arriving every frame: draw
    // it as is. Gliding each one over a route tick, restarted by the next
    // frame, kept the vehicle about half a second behind the footage.
    if(sourceTimeOverride||liveSourceTime){cancelAnimationFrame(routeAnimationFrame);drawReplayRouteAt(layer,marker,remaining.position)}
    else animateReplayRoute(layer,marker,remaining.position);
    const entry=markers.get(item.telemetry.external_id);
    if(entry){entry.estimated=Boolean(estimatedTime);syncVehicleMapLabel(entry)}
    return routeDisplayFromPosition(currentRouteCoordinates,remaining.position,currentRouteBreaks)?.head??null;
  }
  const latLngs=replayOnly?routeDisplayFromPosition(currentRouteCoordinates,remaining.position,currentRouteBreaks)?.latLngs??[]:remaining.latLngs;
  drawWhenNotZooming(layer,()=>layer.setLatLngs(latLngs));
  return null;
}
function drawReplayRouteAt(layer,marker,position){
  const route=routeDisplayFromPosition(currentRouteCoordinates,position,currentRouteBreaks);
  if(!route)return;
  shownRoutePosition=position;
  // Path and vehicle move together, so both wait out a zoom animation.
  drawWhenNotZooming(layer,()=>{
    layer.setLatLngs(route.latLngs);
    cancelGlide(marker);
    marker.setLatLng(route.head);
  });
}
// Moves the shown position to target over one route tick (for the coarse fleet
// and tick updates). A first draw, a hidden page or a jump over 1 km (a seek in
// the recording) is applied at once.
function animateReplayRoute(layer,marker,target){
  cancelAnimationFrame(routeAnimationFrame);
  const from=shownRoutePosition,distances=currentRouteTiming?.distances;
  const metresAt=position=>{
    if(!Array.isArray(distances)||distances.length<2)return null;
    const first=Math.max(0,Math.min(distances.length-1,Math.floor(position))),next=Math.min(distances.length-1,first+1);
    return distances[first]+(position-first)*(distances[next]-distances[first]);
  };
  const jumpM=from==null?null:Math.abs((metresAt(target)??0)-(metresAt(from)??0));
  if(from==null||document.hidden||jumpM>1000){drawReplayRouteAt(layer,marker,target);return}
  const started=performance.now();
  const step=now=>{
    const t=Math.min(1,(now-started)/ROUTE_TICK_MS);
    drawReplayRouteAt(layer,marker,from+(target-from)*t);
    if(t<1)routeAnimationFrame=requestAnimationFrame(step);
  };
  routeAnimationFrame=requestAnimationFrame(step);
}
function showTripDisplay(display){
  const card=document.querySelector('#trip-progress-card');card.hidden=false;
  // The track shows start/end icons; the full names are their tooltip and label.
  for(const [id,prefix,name] of [['#selected-origin','출발지',display.originName||'배정 시점의 차량 위치'],['#selected-destination','목적지',display.destinationName]]){
    const icon=document.querySelector(id),label=`${prefix} · ${name||'—'}`;icon.title=label;icon.setAttribute('aria-label',label);
  }
  const times=tripTimes(display);
  document.querySelector('#selected-origin-time').textContent=times.origin;
  document.querySelector('#selected-destination-time').textContent=times.destination;
  const replayOnly=display.routeMode==='REPLAY_ONLY';
  // The route is drawn only while the trip runs: an assigned (READY) trip shows
  // its card, but no path, and its vehicle follows its GPS rather than a route.
  const running=display.tripStatus==='IN_PROGRESS';
  const key=`${running}:${roadSnapMode}:${display.tripId}:${display.routeMode}:${display.plannedRoute?.routeId??''}:${display.replayPreview?.fingerprint??''}:${display.replayPreview?.roadMatch?.graphVersion??''}:${display.replayPosition?.recordingSessionId??''}`;
  if(key!==displayedRouteKey){
    clearTripLayers();displayedRouteKey=key;
    // Without a road match (routing unavailable or unmatched) fall back to the
    // recorded GPS line itself, so the replay path is never missing.
    // The remaining route and vehicle share the same timed replay line.
    const replayLine=running&&replayOnly?replayRouteLine(display.replayPreview,roadSnapMode):null;
    currentRouteCoordinates=!running?null:replayOnly?replayLine?.coordinates:display.plannedRoute?.routeGeojson?.coordinates;
    currentRouteTiming=replayLine?.timing??null;
    currentRouteBreaks=replayLine?.breaks??[];
    if(running&&!replayOnly&&display.plannedRoute?.routeGeojson)routeLayer=L.polyline([],tripRouteStyle).addTo(map);
    if(replayOnly&&Array.isArray(currentRouteCoordinates)&&currentRouteCoordinates.length>1)replayRouteLayer=L.polyline([],tripRouteStyle).addTo(map);
    const target=!running?null:replayOnly?currentRouteCoordinates?.at(-1):display.plannedRoute?.routeGeojson?.coordinates?.at(-1);
    if(target)destinationMarker=L.circleMarker([target[1],target[0]],{radius:8,color:'#fff',weight:2,fillColor:'#e53955',fillOpacity:1}).addTo(map).bindTooltip(display.destinationName);
  }
  currentTripDisplay=display;
  updateRemainingTripRoute();
  document.querySelector('#route-label').textContent='수송 진행 현황';
  let progress=null,label='진행 상태 대기 중';
  if(replayOnly){
    progress=recordedProgress(display.replayPreview,display.replayPosition?.sourceTimestampNs);
    const replayFix=latestFleet.find(item=>String(item.vehicleId)===String(display.vehicleId)&&item.telemetry?.telemetry_source==='RECORDED_GPS')?.telemetry;
    document.querySelector('#selected-current').textContent=replayFix?`현 위치 · ${replayFix.latitude.toFixed(5)}, ${replayFix.longitude.toFixed(5)}`:'현 위치 대기 중';
    label=progress?`남은 경로: ${(progress.remainingM/1000).toFixed(1)} km`:'GPS 재생 대기 중 · 실제 운행 진행률 아님';
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
    const remaining=remainingRoute(item?.plannedRoute?.routeGeojson?.coordinates,item?.telemetry);
    if(remaining)routeLayer=L.polyline(remaining.latLngs,tripRouteStyle).addTo(map);
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
// Clears the selection: back to the empty "선택 차량" card, without the trip
// route, progress card, live preview (freeing its TURN port) or highlight.
function deselectVehicle(){
  if(!selected)return;
  selected=null;displayRequest++;
  if(liveView)stopLiveView();
  clearTripLayers();
  document.querySelector('#trip-progress-card').hidden=true;
  details.hidden=true;
  document.querySelector('#selection-empty').hidden=false;
  for(const entry of markers.values()){
    setMarkerIcon(entry,vehicleIcon(entry.item,false,false,matchesLiveTarget(entry.item)));
    entry.marker.setZIndexOffset(0);
    // Rebuild the label so only vehicles on a running trip keep a permanent one.
    entry.labelOnTrip=null;syncVehicleMapLabel(entry);
  }
  syncVehiclePickers();
  syncLiveViewButton(null);
}
document.querySelector('#deselect-vehicle').addEventListener('click',deselectVehicle);
function selectVehicle(item){
  selected=item;
  syncVehiclePickers();
  const assignmentVehicle=document.querySelector('#trip-vehicle');
  if(assignmentVehicle&&[...assignmentVehicle.options].some(option=>option.value===String(item.vehicleId))){
    assignmentVehicle.value=String(item.vehicleId);void loadAssignmentPreview();
  }
  syncLiveViewButton(item);
  details.hidden=false;
  renderVehicleDetails(item);
  for(const entry of markers.values()){
    const active=entry.item.telemetry?.external_id===item.telemetry?.external_id;
    setMarkerIcon(entry,vehicleIcon(entry.item,active,false,matchesLiveTarget(entry.item)));
    entry.marker.setZIndexOffset(active?1000:0);
    const showLabel=active||entry.item?.tripStatus==='IN_PROGRESS';
    if(entry.marker.getTooltip())entry.marker.getTooltip().options.permanent=showLabel;
    if(showLabel)entry.marker.openTooltip();else entry.marker.closeTooltip();
  }
  const t=item.telemetry;
  fields.replaceChildren();
  for(const [label,value] of [[uiText('Vehicle'),item.vehicleName||item.vehicleCode||t.external_id],[uiText('Source'),`${item.vehicleSource||'BIMS'} / ${t.telemetry_source}`],[uiText('Status'),item.vehicleStatus||t.source_metadata?.state||'ACTIVE'],[uiText('Speed'),formatSpeed(t.speed_kmh)],[uiText('Observed'),t.observed_at_utc||'—'],[uiText('Trip ID'),item.tripId??'—']]){
    const term=document.createElement('dt'),description=document.createElement('dd');
    term.textContent=label;description.textContent=String(value);fields.append(term,description);
  }
  void loadSelectedTrip();
  selectRecordingTrip(item.tripId);
  if(item.tripId)void loadTripRecordings(String(item.tripId));
  retargetLiveView(item);
  // Open the live view as soon as a streaming vehicle is selected, where it is
  // visible: the "실시간 영상" tab. Only on selection, so closing it sticks.
  if(!liveView&&matchesLiveTarget(item)&&!document.querySelector('#recording-live-content').hidden)openLiveView();
}
window.__operatorCancelMapPick=()=>{tripMapPick=undefined;document.querySelector('#map-pick-banner').hidden=true;document.querySelectorAll('[data-trip-map-pick]').forEach(button=>button.setAttribute('aria-pressed','false'));};
function render(snapshot){
  if(window.__virtualMode)return;
  if(!Array.isArray(snapshot?.vehicles))throw new Error('차량 응답 형식이 올바르지 않습니다.');
  latestFleet=snapshot.vehicles;
  renderVehiclePickers(snapshot.vehicles);
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
    const liveSelected=Boolean(liveView&&liveView.markerKey===key);
    setMarkerIcon(entry,vehicleIcon(item,liveSelected||selected?.telemetry?.external_id===key,false,matchesLiveTarget(item)));
    entry.marker.setZIndexOffset(liveSelected||selected?.telemetry?.external_id===key?1000:0);
    // Live frames own the selected marker between successful fleet polls.
    if(!isLiveOverride(liveView,key,Date.now())){
      if(!routeControlsMarker(item)){
        const estimate=freeReplayWanted(item)?freeReplayEstimate(item.vehicleId,streamReplayTime(item)):null;
        glideMarker(entry.marker,estimate?.inGap?estimate.latLng:pos,FLEET_POLL_MS);
        setFreeEstimated(entry,Boolean(estimate?.inGap));
      }
      // The replay vehicle is followed from its position on the route (route
      // tick); following its raw fix here would pull the camera back to it -
      // in a tunnel, to the entrance - every poll.
      // Camera only: the glide above moves the marker, and update() would cancel it.
      if(liveView?.markerKey===key&&liveMapFollower.isFollowing()&&!routeControlsMarker(item))liveMapFollower.follow(pos);
    }
    const session=t.source_metadata?.recordingSessionId;
    // A new stream session supersedes the old one; reject its late frames.
    if(liveView?.markerKey===key&&typeof session==='string'&&session!==liveView.recordingSessionId){liveView.recordingSessionId=session;resetLiveFrameOrder(liveView)}
    syncVehicleMapLabel(entry);
  }
  dashboard.update(snapshot.vehicles);
  for(const item of snapshot.vehicles){
    const watched=item.telemetry?.external_id===selected?.telemetry?.external_id||item.telemetry?.external_id===liveView?.markerKey;
    if(watched&&freeReplayWanted(item))ensureFreeReplay(item.vehicleId);
  }
  updateRemainingTripRoute();
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
  // The replay path's final GPS point is the destination, so there is nothing to ask.
  document.querySelector('#trip-destination-fields').hidden=replayOnly;
  for(const id of ['trip-destination-name','trip-destination-latitude','trip-destination-longitude']){
    const field=document.getElementById(id);field.disabled=replayOnly;field.required=!replayOnly;
  }
  if(replayOnly&&tripMapPick==='destination')window.__operatorCancelMapPick();
  // Only actionable problems are shown: why the create button is disabled.
  const preview=assignmentPreview,notice=document.querySelector('#trip-preview-status');
  const vehicleValue=document.querySelector('#trip-vehicle').value;
  // The server rejects a second active assignment; say so before the operator submits.
  const activeTripId=activeTripByVehicle.get(vehicleValue);
  notice.textContent=activeTripId?`Trip ID ${activeTripId}이(가) 이미 배정되어 있습니다. 취소하거나 완료한 뒤 새로 배정하세요.`
    :replayOnly&&vehicleValue&&!preview?'이 차량의 Android 앱에서 GPS 데이터셋을 먼저 선택하세요.':'';
  notice.hidden=!notice.textContent;
  document.querySelector('#create-trip').disabled=Boolean(activeTripId)||(replayOnly&&!preview);
  // The path the server will pin is described, not drawn: a path drawn on the
  // map beside the always-open form read as an assigned (or cancelled) trip.
  const summary=document.querySelector('#trip-preview-summary');
  summary.textContent=replayOnly&&preview&&!activeTripId
    ?`배정될 GPS 경로 · ${preview.datasetName||preview.fingerprint?.slice(0,8)||'—'} · ${((preview.totalDistanceM??0)/1000).toFixed(1)} km · 도로 매칭 ${preview.roadMatch?'완료':'불가'}`:'';
  summary.hidden=!summary.textContent;
}
tripRouteMode.addEventListener('change',()=>{localStorage.setItem('operatorTripRouteMode',tripRouteMode.value);syncTripRouteMode()});
syncTripRouteMode();
async function loadAssignmentPreview(){
  const vehicleId=document.querySelector('#trip-vehicle').value;
  if(vehicleId!==assignmentPreviewVehicleId){assignmentPreviewVehicleId=vehicleId;assignmentPreview=null;syncTripRouteMode()}
  if(!vehicleId)return;
  try{const preview=await api(`/api/v1/trips/vehicles/${vehicleId}/replay-preview`,{},true);
    if(document.querySelector('#trip-vehicle').value===vehicleId){assignmentPreview=preview;syncTripRouteMode()}}
  catch(ex){const notice=document.querySelector('#trip-preview-status');notice.textContent=`Android GPS 경로 확인 실패 · ${ex.message}`;notice.hidden=false}
}
document.querySelector('#trip-vehicle').addEventListener('change',()=>void loadAssignmentPreview());
// Trips change on the phone too (Start/Stop Trip), so the list is polled; it is
// only rebuilt when the data changed, so buttons do not flicker or lose focus.
let tripListSignature='';
const pendingTripActions=new Set();

function clearDeletedTrip(tripId){
  if(String(currentTripDisplay?.tripId)===tripId){displayRequest++;clearTripLayers();document.querySelector('#trip-progress-card').hidden=true}
  if(String(selected?.tripId)===tripId)selected={...selected,tripId:null,tripStatus:null};
  if(replayTripId===tripId){
    recordingsRequest++;stopRecordingPlayback();closeRecordingDeleteMode();
    replayTripId='';tripRecordingVideos=[];replayTimeline=[];replayDuration=0;
    setReplayPosition(0);
    renderReplayBreakMarkers();updateRecordingDeleteTools();selectRecordingTrip('');
    document.querySelector('#recording-player-panel').hidden=true;
    document.querySelector('#recordings-status').textContent=`운행 ${tripId}이(가) 삭제되었습니다.`;
  }
  const picker=document.querySelector('#recording-trip-id');
  for(const option of [...picker.options])if(option.value===tripId)option.remove();
}

function createTripActions(trip){
  const action=tripAction(trip.tripStatus,currentRole);
  if(!action)return null;
  const tripId=String(trip.tripId),menu=document.createElement('details'),toggle=document.createElement('summary'),button=document.createElement('button');
  menu.className='trip-actions';toggle.textContent='⋮';toggle.setAttribute('aria-label',`운행 ${tripId} 작업`);
  button.type='button';button.textContent=action==='cancel'?'운행 취소':'운행 삭제';button.disabled=pendingTripActions.has(tripId);
  button.addEventListener('click',async()=>{
    if(pendingTripActions.has(tripId)||!['ADMIN','OPERATOR'].includes(currentRole))return;
    if(action==='delete'&&recordingDeleteBusy){document.querySelector('#trip-status-message').textContent='녹화 삭제가 끝난 후 운행 삭제를 시도하세요.';return}
    if(action==='cancel'&&!window.confirm(`Trip ID ${tripId} 배정을 취소할까요?`))return;
    pendingTripActions.add(tripId);button.disabled=true;menu.open=false;
    const notice=document.querySelector('#trip-status-message');let ownsRecordingDelete=false;
    try{
      if(action==='cancel'){
        await api(`/api/v1/trips/${encodeURIComponent(tripId)}/cancel`,{method:'POST',body:'{}'},true);
        notice.textContent=`운행 ${tripId} 취소 완료.`;
      }else{
        notice.textContent=`운행 ${tripId} 녹화 확인 중…`;
        const deleted=await deleteTripWithRecordings(api,tripId,text=>{
          if(recordingDeleteBusy)throw new Error('녹화 삭제가 끝난 후 운행 삭제를 시도하세요.');
          return window.confirm(text);
        },()=>{
          recordingDeleteBusy=true;ownsRecordingDelete=true;updateRecordingDeleteTools();notice.textContent=`운행 ${tripId} 삭제 중…`;
          if(replayTripId===tripId){closeRecordingDeleteMode();stopRecordingPlayback()}
        });
        if(!deleted){notice.textContent='운행 삭제를 취소했습니다.';return}
        clearDeletedTrip(tripId);notice.textContent=`운행 ${tripId} 삭제 완료.`;
      }
    }catch(ex){
      notice.textContent=/not active/i.test(ex.message)?`Trip ID ${tripId}은(는) 이미 종료된 운행입니다.`:ex.message;
      if(action==='delete'&&replayTripId===tripId)await loadTripRecordings(tripId);
    }finally{
      if(ownsRecordingDelete){recordingDeleteBusy=false;updateRecordingDeleteTools()}
      pendingTripActions.delete(tripId);button.disabled=false;
      tripListSignature='';
      await loadTripAssignments().catch(()=>{});await refresh().catch(()=>{});
    }
  });
  menu.append(toggle,button);return menu;
}
async function loadTripAssignments(){
  const [vehicles,trips]=await Promise.all([api('/api/v1/vehicles',{},true),api('/api/v1/trips',{},true)]);
  const signature=JSON.stringify([vehicles,trips,currentRole]);
  if(signature===tripListSignature)return;
  tripListSignature=signature;
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
  renderRecordingTripOptions(trips);
  const list=document.querySelector('#trips-list');list.replaceChildren();
  for(const trip of trips){
    const row=document.createElement('li'),title=document.createElement('strong'),vehicle=document.createElement('span'),destination=document.createElement('span'),status=document.createElement('span');
    title.textContent=`Trip ID ${trip.tripId}`;
    vehicle.textContent=`Vehicle ID ${trip.vehicleId} · ${trip.vehicle.vehicleCode}${trip.vehicle.vehicleName?` · ${trip.vehicle.vehicleName}`:''}`;
    destination.textContent=`${trip.originName?`${trip.originName} → `:''}${trip.destinationName}`;
    status.textContent=`${TRIP_STATUS_LABELS[trip.tripStatus]||trip.tripStatus} · ${trip.routeMode==='REPLAY_ONLY'?'Android GPS 재생 경로만':'최적 경로 + Android GPS 재생'}${trip.plannedStartAt?` · planned ${new Date(trip.plannedStartAt).toLocaleString()}`:''}`;
    const header=document.createElement('div');header.className='trip-row-header';header.append(title);
    const actions=createTripActions(trip);if(actions)header.append(actions);
    row.append(header,vehicle,destination,status);
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
  // Demo mode never loads trips, so the recordings picker has none to offer.
  if(demoMode)renderRecordingTripOptions([]);
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
  clearInterval(tripListTimer);tripListTimer=demoMode?undefined:setInterval(()=>void loadTripAssignments().catch(ex=>console.warn('[operator trips]',ex)),5000);
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
function updateRecordingDeleteTools(){
  document.querySelector('#recording-delete-tools').hidden=!['ADMIN','OPERATOR'].includes(currentRole)||!tripRecordingVideos.length;
  document.querySelector('#recording-delete-toggle').disabled=recordingDeleteBusy||!replayTimeline.length;
  document.querySelector('#recording-delete-trip').disabled=recordingDeleteBusy||!tripRecordingVideos.length;
}
function clearRecordingDeleteSelection(){document.querySelector('#recording-delete-selection').hidden=true;document.querySelector('#recording-delete-selected').disabled=true;document.querySelector('#recording-delete-selection-status').textContent=uiText('No segments selected.');recordingDeleteRange=null;recordingDeleteDrag=null}
function openRecordingDeleteMode(){if(!replayTimeline.length)return;renderRecordingDeleteTimeline();document.querySelector('#recording-delete-mode').hidden=false;document.querySelector('#recording-timeline').classList.add('is-delete-mode');document.querySelector('#recording-seek').disabled=true;document.querySelector('#recording-delete-range').hidden=false;replayPlayer().pause();document.querySelector('#recording-delete-toggle').textContent=uiText('Exit delete mode');document.querySelector('#recording-delete-range').focus()}
function closeRecordingDeleteMode(){document.querySelector('#recording-delete-mode').hidden=true;document.querySelector('#recording-delete-toggle').textContent=uiText('Delete segments');document.querySelector('#recording-timeline').classList.remove('is-delete-mode');document.querySelector('#recording-seek').disabled=false;document.querySelector('#recording-delete-range').hidden=true;document.querySelector('#recording-delete-segments').replaceChildren();clearRecordingDeleteSelection()}
function renderRecordingDeleteTimeline(){const segments=document.querySelector('#recording-delete-segments');segments.replaceChildren();for(const entry of replayTimeline){const marker=document.createElement('span');marker.style.left=`${entry.start/replayDuration*100}%`;marker.style.width=`${entry.duration/replayDuration*100}%`;marker.title=`Segment ${entry.video.segmentIndex} · ${formatReplayTime(entry.start)}–${formatReplayTime(entry.end)}`;segments.append(marker)}}
function setRecordingDeleteRange(firstIndex,lastIndex){if(recordingDeleteBusy||!replayTimeline.length)return;const first=Math.max(0,Math.min(replayTimeline.length-1,Math.min(firstIndex,lastIndex))),last=Math.max(first,Math.min(replayTimeline.length-1,Math.max(firstIndex,lastIndex)));recordingDeleteRange={first,last};const firstEntry=replayTimeline[first],lastEntry=replayTimeline[last],selection=document.querySelector('#recording-delete-selection'),left=firstEntry.start/replayDuration*100,right=lastEntry.end/replayDuration*100;selection.style.left=`${left}%`;selection.style.width=`${Math.max(0,right-left)}%`;selection.hidden=false;document.querySelector('#recording-delete-selected').disabled=false;document.querySelector('#recording-delete-selection-status').textContent=`${last-first+1} contiguous segment${last===first?'':'s'} selected · segments ${firstEntry.video.segmentIndex}–${lastEntry.video.segmentIndex} · ${formatReplayTime(firstEntry.start)}–${formatReplayTime(lastEntry.end)}.`}
function recordingDeleteIndexAt(clientX){const range=document.querySelector('#recording-delete-range').getBoundingClientRect(),ratio=Math.max(0,Math.min(1,(clientX-range.left)/Math.max(1,range.width))),position=ratio*replayDuration;let index=replayTimeline.findIndex((entry,current)=>position>=entry.start&&(position<entry.end||(current===replayTimeline.length-1&&position<=entry.end)));if(index<0)index=position>=replayDuration?replayTimeline.length-1:0;return index}
function adjustRecordingDeleteRange(event){if(!replayTimeline.length)return;const delta=event.key==='ArrowRight'||event.key==='ArrowUp'?1:event.key==='ArrowLeft'||event.key==='ArrowDown'?-1:0;if(event.key==='Home'){event.preventDefault();setRecordingDeleteRange(0,0);return}if(event.key==='End'){event.preventDefault();setRecordingDeleteRange(replayTimeline.length-1,replayTimeline.length-1);return}if(!delta)return;event.preventDefault();if(!recordingDeleteRange){const index=replayIndex>=0?replayIndex:0;setRecordingDeleteRange(index,index);return}if(event.shiftKey){const first=Math.max(0,Math.min(recordingDeleteRange.last,recordingDeleteRange.first+delta));setRecordingDeleteRange(first,recordingDeleteRange.last)}else{const last=Math.max(recordingDeleteRange.first,Math.min(replayTimeline.length-1,recordingDeleteRange.last+delta));setRecordingDeleteRange(recordingDeleteRange.first,last)}}
function beginRecordingDeleteRange(event){if(event.button!==0||!replayTimeline.length)return;event.preventDefault();const range=document.querySelector('#recording-delete-range'),index=recordingDeleteIndexAt(event.clientX);recordingDeleteDrag={pointerId:event.pointerId,anchor:index};range.setPointerCapture(event.pointerId);setRecordingDeleteRange(index,index)}
function moveRecordingDeleteRange(event){if(!recordingDeleteDrag||recordingDeleteDrag.pointerId!==event.pointerId)return;setRecordingDeleteRange(recordingDeleteDrag.anchor,recordingDeleteIndexAt(event.clientX))}
function finishRecordingDeleteRange(event){if(!recordingDeleteDrag||recordingDeleteDrag.pointerId!==event.pointerId)return;recordingDeleteDrag=null}
async function deleteRecordingSelection(videos,tripId,keepDeleteMode=false){
  if(recordingDeleteBusy||!['ADMIN','OPERATOR'].includes(currentRole))return;
  recordingDeleteBusy=true;updateRecordingDeleteTools();
  document.querySelector('#recording-delete-selected').disabled=true;
  if(!keepDeleteMode)closeRecordingDeleteMode();
  stopRecordingPlayback();
  document.querySelector('#recordings-status').textContent=`녹화 ${videos.length}개 삭제 중…`;
  try{
    const result=await deleteRecordingSnapshot(api,tripId,videos);
    if(replayTripId!==tripId)return;
    await loadTripRecordings(tripId,keepDeleteMode);
    if(replayTripId!==tripId)return;
    document.querySelector('#recordings-status').textContent=result.failures.length
      ?`운행 ${tripId}: ${result.deletedTripVideoIds.length}개 삭제 · ${result.failures.length}개 실패: ${result.failures[0].message}`
      :`운행 ${tripId}: 녹화 ${result.deletedTripVideoIds.length}개와 해당 재생 감지 데이터 삭제 완료.`;
  }finally{recordingDeleteBusy=false;updateRecordingDeleteTools()}
}
async function deleteAllTripRecordings(){
  if(recordingDeleteBusy||!tripRecordingVideos.length||!['ADMIN','OPERATOR'].includes(currentRole))return;
  const tripId=replayTripId,videos=[...tripRecordingVideos];
  if(!window.confirm(`운행 ${tripId}의 저장된 녹화 ${videos.length}개와 해당 재생 감지 데이터를 영구 삭제하시겠습니까? 운행·GPS 기록은 유지되며, 이후 추가되는 녹화는 삭제하지 않습니다.`))return;
  await deleteRecordingSelection(videos,tripId);
}
async function deleteSelectedRecordingSegments(){
  if(recordingDeleteBusy||!recordingDeleteRange||!['ADMIN','OPERATOR'].includes(currentRole))return;
  const selected=replayTimeline.slice(recordingDeleteRange.first,recordingDeleteRange.last+1),first=selected[0],last=selected.at(-1),tripId=replayTripId;
  if(!selected.length)return;
  const prompt=`Permanently delete ${selected.length} contiguous recording segment${selected.length===1?'':'s'} from trip ${tripId} (segments ${first.video.segmentIndex}–${last.video.segmentIndex}, ${formatReplayTime(first.start)}–${formatReplayTime(last.end)}) and their replay detections?`;
  if(!window.confirm(prompt))return;
  await deleteRecordingSelection(selected.map(entry=>entry.video),tripId,true);
}
function waitForVideoMetadata(player){return new Promise((resolve,reject)=>{const loaded=()=>{cleanup();resolve()},failed=()=>{cleanup();reject(new Error('The recording video could not be loaded'))},cleanup=()=>{player.removeEventListener('loadedmetadata',loaded);player.removeEventListener('error',failed)};if(player.readyState>=1){resolve();return}player.addEventListener('loadedmetadata',loaded,{once:true});player.addEventListener('error',failed,{once:true})})}
function loadReplayDetections(entry){if(entry.samplesLoaded)return Promise.resolve();if(entry.sampleLoadPromise)return entry.sampleLoadPromise;entry.sampleLoadPromise=api(`/api/v1/trips/${encodeURIComponent(replayTripId)}/videos/${encodeURIComponent(entry.video.tripVideoId)}/detections`,{},true).then(result=>{entry.samples=result.samples||[];entry.coverageIncomplete=Boolean(result.coverageIncomplete)}).catch(()=>{entry.samples=[];entry.coverageIncomplete=true}).finally(()=>{entry.samplesLoaded=true;entry.sampleLoadPromise=null;renderReplayBreakMarkers();if(replayTimeline[replayIndex]===entry)drawReplayOverlay()});return entry.sampleLoadPromise}
async function activateReplaySegment(index,localTime,autoplay,generation){const entry=replayTimeline[index],player=replayPlayer();if(!entry||entry.unavailable)throw new Error('This recording segment is unavailable');const switchSegment=replayIndex!==index||!player.currentSrc,urlPromise=switchSegment?api(`/api/v1/trip-videos/${encodeURIComponent(entry.video.tripVideoId)}/playback-url`,{method:'POST'},true):Promise.resolve({url:entry.playbackUrl});const [url]=await Promise.all([urlPromise,loadReplayDetections(entry)]);if(generation!==replayGeneration)return false;if(switchSegment){entry.playbackUrl=url.url;player.src=url.url;player.load();await waitForVideoMetadata(player);if(generation!==replayGeneration)return false}replayIndex=index;const safeDuration=Number.isFinite(player.duration)?player.duration:entry.duration;player.currentTime=Math.min(Math.max(0,localTime),Math.max(0,safeDuration-.02));setReplayPosition(entry.start+player.currentTime);if(autoplay)await player.play();drawReplayOverlay();return true}
async function seekReplay(position,autoplay=true,direction=1,preferredIndex=-1){if(!replayTimeline.length)return;const generation=++replayGeneration,player=replayPlayer();player.pause();let target=Math.max(0,Math.min(replayDuration,Number(position)||0));let index=preferredIndex>=0?preferredIndex:entryForTime(replayTimeline,replayDuration,target,direction);if(index<0)index=direction<0?replayTimeline.length-1:0;for(let attempt=0;attempt<replayTimeline.length;attempt++){const entry=replayTimeline[index];if(entry.unavailable){index+=direction;if(index<0||index>=replayTimeline.length)break;target=replayTimeline[index].start;continue}try{const ok=await activateReplaySegment(index,Math.max(0,target-entry.start),autoplay,generation);if(!ok)return;document.querySelector('#recordings-status').textContent=`Playing trip timeline · segment ${entry.video.segmentIndex} of ${replayTimeline.length}.`;return}catch(ex){if(generation!==replayGeneration)return;entry.unavailable=true;renderReplayBreakMarkers();document.querySelector('#recordings-status').textContent=`Segment ${entry.video.segmentIndex} is unavailable (${ex.message}); skipping to the next segment.`;index+=direction;if(index<0||index>=replayTimeline.length)break;target=replayTimeline[index].start}}player.pause();document.querySelector('#recordings-status').textContent='No playable recording segments remain in this direction.'}
async function loadTripRecordings(value,keepDeleteMode=false){const deleteMode=document.querySelector('#recording-delete-mode'),resumeDeleteMode=keepDeleteMode&&!deleteMode.hidden;if(resumeDeleteMode){clearRecordingDeleteSelection();document.querySelector('#recording-delete-segments').replaceChildren()}else{closeRecordingDeleteMode();document.querySelector('#recording-delete-tools').hidden=true}const requestId=++recordingsRequest,tripId=String(value||'').trim(),status=document.querySelector('#recordings-status');tripRecordingVideos=[];replayTimeline=[];replayDuration=0;replayTripId=tripId;updateRecordingDeleteTools();renderReplayBreakMarkers();stopRecordingPlayback();document.querySelector('#recording-player-panel').hidden=true;if(!/^[1-9][0-9]{0,18}$/.test(tripId)){status.textContent='Select a vehicle with a trip or enter a positive Trip ID.';return}status.textContent=`Loading trip ${tripId}…`;try{await requireRecordingLogin();const videos=await api(`/api/v1/trips/${encodeURIComponent(tripId)}/videos`,{},true);if(requestId!==recordingsRequest)return;if(!videos.length){closeRecordingDeleteMode();document.querySelector('#recording-delete-tools').hidden=true;renderReplayBreakMarkers();status.textContent=`No finalized recording segments are available for trip ${tripId}.`;return}tripRecordingVideos=videos;const timeline=buildReplayTimeline(videos);replayTimeline=timeline.entries;replayDuration=timeline.duration;renderReplayBreakMarkers();updateRecordingDeleteTools();if(!replayTimeline.length){closeRecordingDeleteMode();updateRecordingDeleteTools();status.textContent=`Trip ${tripId} has no segments with a usable duration.`;return}document.querySelector('#recording-player-panel').hidden=false;const seek=document.querySelector('#recording-seek');seek.max=String(replayDuration);seek.value='0';document.querySelector('#recording-time').textContent=`0:00 / ${formatReplayTime(replayDuration)}`;if(resumeDeleteMode)openRecordingDeleteMode();status.textContent=resumeDeleteMode?`Trip ${tripId}: ${replayTimeline.length} segments remain. Delete mode is active; select another range to continue.`:`Trip ${tripId}: ${replayTimeline.length} segments, ${formatReplayTime(replayDuration)} total. Loading detections as segments play.`;await seekReplay(0,false)}catch(ex){if(requestId!==recordingsRequest)return;if(resumeDeleteMode&&!replayTimeline.length){closeRecordingDeleteMode();updateRecordingDeleteTools();renderReplayBreakMarkers()}status.textContent=ex.message}}
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
document.querySelector('#recordings-form').addEventListener('submit',event=>{event.preventDefault();const tripId=document.querySelector('#recording-trip-id').value;if(tripId)void loadTripRecordings(tripId)});
// Choosing a trip loads its recordings right away.
document.querySelector('#recording-trip-id').addEventListener('change',event=>{if(event.currentTarget.value)void loadTripRecordings(event.currentTarget.value)});
// The recordings trip picker lists the recent trips (newest first); with none it says so.
function renderRecordingTripOptions(trips){
  const select=document.querySelector('#recording-trip-id'),previous=select.value;
  select.replaceChildren();
  if(!trips.length){select.add(new Option('없음','',true,true));select.options[0].disabled=true;return}
  select.add(new Option('운행 선택','',!previous,!previous));select.options[0].disabled=true;
  for(const trip of trips){
    const vehicle=trip.vehicle?.vehicleCode||`Vehicle ${trip.vehicleId}`;
    select.add(new Option(`운행 ${trip.tripId} · ${vehicle} · ${TRIP_STATUS_LABELS[trip.tripStatus]||trip.tripStatus}`,String(trip.tripId)));
  }
  if(previous)selectRecordingTrip(previous);
}
// Selects a trip in the picker, adding it if it is older than the listed ones.
function selectRecordingTrip(tripId){
  const select=document.querySelector('#recording-trip-id');
  if(!tripId){if(select.options[0]&&!select.options[0].value)select.selectedIndex=0;return}
  const value=String(tripId);
  if(![...select.options].some(option=>option.value===value)){
    if(select.options.length===1&&!select.options[0].value&&select.options[0].textContent==='없음')select.replaceChildren(new Option('운행 선택','',false,false));
    select.add(new Option(`운행 ${value}`,value));
  }
  select.value=value;
}
document.querySelector('#stop-recording').addEventListener('click',stopRecordingPlayback);
document.querySelector('#recording-delete-toggle').addEventListener('click',event=>{const mode=document.querySelector('#recording-delete-mode');if(mode.hidden){openRecordingDeleteMode();document.querySelector('#recordings-status').textContent='Drag across the timeline to select a contiguous range of segments.'}else{closeRecordingDeleteMode();document.querySelector('#recordings-status').textContent='Delete mode closed.'}});
document.querySelector('#recording-delete-cancel').addEventListener('click',()=>{closeRecordingDeleteMode();document.querySelector('#recordings-status').textContent='Delete mode closed.'});
document.querySelector('#recording-delete-select-all').addEventListener('click',()=>{if(replayTimeline.length)setRecordingDeleteRange(0,replayTimeline.length-1)});
document.querySelector('#recording-delete-selected').addEventListener('click',()=>void deleteSelectedRecordingSegments());
document.querySelector('#recording-delete-trip').addEventListener('click',()=>void deleteAllTripRecordings());
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
function setLiveViewLoading(loading,text='실시간 영상 연결 중…'){
  const indicator=document.querySelector('#live-view-loading');
  indicator.hidden=!loading;
  indicator.textContent=text;
  liveFrame.setAttribute('aria-busy',String(loading));
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
  refreshLiveMarkerIcons();
  document.querySelector('#live-view-title').textContent='실시간 전방 영상';
  clearInterval(liveStatusTimer);liveStatusTimer=undefined;
  refreshMapLayout();
  if(!document.querySelector('#details').hidden)document.querySelector('#recording-live-tab').focus({preventScroll:true});
  syncLiveViewButton();
  renderLiveTelemetryStatus();
}
// The virtual workspace takes over the map and the sidebar, so it closes Live
// View on the way in. Hiding the panel alone would leave the live-view-open
// layout class - and with it a display:none sidebar - behind.
window.__operatorStopLiveView=stopLiveView;
// Virtual mode closes Live View; these let it reopen for the same vehicle on return.
window.__operatorLiveViewOpen=()=>Boolean(liveView);
window.__operatorResumeLiveView=()=>{if(!liveView&&matchesLiveTarget(selected))openLiveView()};
window.addEventListener('message',event=>{
  if(liveView&&event.origin===liveView.frameOrigin&&event.source===liveFrame.contentWindow&&event.data?.type==='live-view-playback-state'){
    setLiveViewLoading(event.data.loading===true,typeof event.data.text==='string'?event.data.text:undefined);
    return;
  }
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
  lastLiveMessage=message;lastLiveMessageAt=Date.now();
  window.__liveFrameDebug={at:new Date().toISOString(),status:message.telemetry?.status??null,hasGps:Boolean(message.telemetry?.gps),
    frameTime:message.telemetry?.source_timestamp_ns??message.sourceTimestampNs??null,tripShown:currentTripDisplay?.tripId??null,
    routeMode:currentTripDisplay?.routeMode??null,sameVehicle:String(liveView?.vehicleId)===String(currentTripDisplay?.vehicleId)};
  const position=applyLiveTelemetry(liveView,message,Date.now());
  const tripRunsHere=currentTripDisplay?.tripStatus==='IN_PROGRESS'&&String(liveView?.vehicleId)===String(currentTripDisplay.vehicleId);
  if(!position&&tripRunsHere&&currentTripDisplay.routeMode==='REPLAY_ONLY'){
    // No GPS for this frame (a tunnel): place the replay vehicle by its time.
    const snapped=presentedFrameTime()?updateRemainingTripRoute():null;
    if(snapped&&liveMapFollower.isFollowing())liveMapFollower.follow(snapped);
  }else if(!position&&!tripRunsHere){
    // No running trip: estimate along the vehicle's uploaded path by the frame's
    // time, and keep the fleet poll from pulling it back to a placeholder fix.
    const estimate=freeReplayEstimate(liveView?.vehicleId,presentedFrameTime());
    if(estimate){liveView.lastUpdateAt=Date.now();setFreeEstimated(liveMapFollower.update(estimate.latLng),true)}
  }
  if(position)setFreeEstimated(markers.get(liveView?.markerKey),false);
  if(position){
    const snapped=currentTripDisplay&&String(liveView?.vehicleId)===String(currentTripDisplay.vehicleId)
      ?updateRemainingTripRoute({latitude:position[0],longitude:position[1]},message.telemetry?.source_timestamp_ns):null;
    // A route-placed replay vehicle: only the camera follows; the route
    // animation alone moves its marker.
    if(snapped)liveMapFollower.follow(snapped);else liveMapFollower.update(position);
  }
  renderLiveTelemetryStatus();
});
installForegroundResume(window,document,()=>{
  if(!liveView||document.hidden)return;
  setLiveViewLoading(true,'최신 실시간 영상으로 연결 중…');
  notifyLiveFrameFullscreen();
  liveFrame.contentWindow?.postMessage({type:FOREGROUND_RESUME_MESSAGE},liveView.frameOrigin);
});
// Keep the displayed road position moving briefly through a replay GPS gap.
setInterval(()=>{
  if(document.hidden||currentTripDisplay?.routeMode!=='REPLAY_ONLY'||currentTripDisplay.tripStatus!=='IN_PROGRESS')return;
  const snapped=updateRemainingTripRoute();
  if(snapped&&liveView?.vehicleId===String(currentTripDisplay.vehicleId)&&liveMapFollower.isFollowing())liveMapFollower.follow(snapped);
},ROUTE_TICK_MS);
// With no open button, the "실시간 영상" tab reopens a closed preview for a streaming vehicle.
document.querySelector('#recording-live-tab').addEventListener('click',()=>{if(!liveView)openLiveView()});
function openLiveView(){
  if(!bootstrap||!matchesLiveTarget(selected))return;
  const liveViewUrlObject=new URL(browserReachableUrl(bootstrap.liveViewUrl));
  liveViewUrlObject.searchParams.set('autostart','1');
  liveViewUrlObject.searchParams.set('embedded','1');
  const liveViewUrl=liveViewUrlObject.href;
  const diagnostic=document.querySelector('#live-view-diagnostic');
  diagnostic.textContent=`Live View origin: ${new URL(liveViewUrl).origin}`;
  if(!window.isSecureContext)diagnostic.textContent+=' — dashboard is not a secure context; open its HTTPS URL';
  liveView=createLiveView(selected,new URL(liveViewUrl).origin);lastLiveMessage=null;
  liveMapFollower.begin(liveView);
  refreshLiveMarkerIcons();
  updateLiveTitle();
  clearInterval(liveStatusTimer);liveStatusTimer=setInterval(renderLiveTelemetryStatus,1000);
  renderLiveTelemetryStatus();
  setLiveViewLoading(true);
  livePanel.hidden=false;
  // Restore the operator's saved docked or floating placement.
  placeLivePanel(liveDocked);
  // Set the URL only after opening the panel so navigation/playback starts as
  // part of the user's click instead of while the iframe is hidden.
  liveFrame.src=liveViewUrl;
  syncLiveViewButton();
}
function refreshLiveMarkerIcons(){
  for(const [key,entry] of markers){
    const live=matchesLiveTarget(entry.item);
    setMarkerIcon(entry,vehicleIcon(entry.item,liveView?.markerKey===key||selected?.telemetry?.external_id===key,false,live));
  }
}
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
// There is no close button: the preview closes when another vehicle is
// selected, or when "저장된 녹화" is shown while it is docked.
liveRecenterButton.addEventListener('click',()=>liveMapFollower.recenter());
const liveFullscreenButton=document.querySelector('#live-fullscreen');
function syncLiveFullscreenButton(){const fullscreen=document.fullscreenElement===livePanel;liveFullscreenButton.textContent=fullscreen?'전체 화면 종료':'전체 화면';liveFullscreenButton.setAttribute('aria-label',fullscreen?'Exit full-screen Live View':'View Live View full screen')}
if(!document.fullscreenEnabled||typeof livePanel.requestFullscreen!=='function')liveFullscreenButton.hidden=true;
else{
  liveFullscreenButton.addEventListener('click',async()=>{try{if(document.fullscreenElement===livePanel)await document.exitFullscreen();else await livePanel.requestFullscreen()}catch{document.querySelector('#live-view-diagnostic').textContent='Full-screen Live View is unavailable in this browser.'}});
  document.addEventListener('fullscreenchange',()=>{syncLiveFullscreenButton();if(document.fullscreenElement!==livePanel)liveFullscreenDetails=false;syncLiveDetails();requestAnimationFrame(()=>map.invalidateSize({pan:false}))});
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
  const mode=tripRouteMode.value;
  if(mode==='REPLAY_ONLY'&&!assignmentPreview){message.textContent='Android GPS 경로를 먼저 받아야 합니다.';return}
  const body={vehicleId:value('trip-vehicle'),routeMode:mode,tripStatus:'READY'};
  if(mode==='REPLAY_ONLY'&&assignmentPreview)body.replayPreviewId=String(assignmentPreview.replayPreviewId);
  if(mode==='DUAL'){
    body.destinationName=value('trip-destination-name');
    body.destinationLatitude=Number(value('trip-destination-latitude'));
    body.destinationLongitude=Number(value('trip-destination-longitude'));
  }
  // Origin, address and initial state are no longer asked: the server uses the
  // vehicle's current BIMS or Android position as the origin, and trips start READY.
  button.disabled=true;message.textContent='Creating trip…';
  try{
    const trip=await api('/api/v1/trips',{method:'POST',body:JSON.stringify(body)},true);
    message.textContent=`Trip ID ${trip.tripId} 배정 완료 · Android에서 운행 시작을 누르세요.`;
    selectRecordingTrip(trip.tripId);
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
