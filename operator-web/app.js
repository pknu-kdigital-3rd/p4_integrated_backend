import {buildReplayTimeline,detectionSampleAtPts,entryForTime} from './replay-timeline.js';
import {acceptLiveTelemetry,applyLiveTelemetry,createLiveView,describeLiveTelemetry,isLiveOverride} from './live-telemetry.js';
import {createAndroidMarkerRevealer,createLiveMapFollower,fleetMarkerStyle,isAndroidGpsItem,LIVE_MARKER_STYLE} from './live-map.js';
import {FOREGROUND_RESUME_MESSAGE,installForegroundResume} from './foreground-resume.js';
const map=L.map('map').setView([35.1796,129.0756],12);
window.__operatorMap=map;
L.tileLayer('/osm/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap contributors'}).addTo(map);
const markers=new Map(),tripMapMarkers=new Map();let token=sessionStorage.getItem('itsToken');let bootstrap;let selected;let routeLayer;let demoMode=false;let currentRole='';let recordingsRequest=0;let refreshTimer;let tripMapPick;let replayTimeline=[];let replayDuration=0;let replayIndex=-1;let replayGeneration=0;let replayTripId='';let recordingDeleteRange=null;let recordingDeleteDrag=null;let replayScrubbing=false;let replayScrubWasPlaying=false;let replaySeekGeneration=0;let replaySeekPending=false;let liveView=null;let lastLiveMessage=null;let liveStatusTimer;
const error=document.querySelector('#error'),details=document.querySelector('#details'),fields=document.querySelector('#fields');
const operatorLayout=document.querySelector('#operator-layout'),layoutSplitter=document.querySelector('#layout-splitter'),stackedLayout=window.matchMedia('(max-width: 1000px)');
const livePanel=document.querySelector('#live-view-panel'),liveFrame=document.querySelector('#live-view-frame'),liveRecenterButton=document.querySelector('#live-recenter');
function createMarkerEntry(item,position,{liveOnly=false}={}){
  const androidGps=isAndroidGpsItem(item),marker=L.circleMarker(position,{radius:liveOnly||androidGps?10:8,...(liveOnly?LIVE_MARKER_STYLE:fleetMarkerStyle(item))}).addTo(map);
  const entry={marker,item,liveOnly};
  marker.on('click',()=>selectVehicle(entry.item));
  marker.bindTooltip(androidGps?`Android GPS · ${item?.vehicleCode||item?.telemetry?.external_id||'vehicle'}`:item?.vehicleCode||item?.telemetry?.external_id||'Live vehicle');
  if(item?.telemetry?.external_id)markers.set(item.telemetry.external_id,entry);
  return entry;
}
const liveMapFollower=createLiveMapFollower({
  map,markers,
  createEntry:(item,position)=>createMarkerEntry(item,position,{liveOnly:true}),
  onFollowingChange:following=>{liveRecenterButton.hidden=following;liveRecenterButton.setAttribute('aria-pressed',String(following))},
});
const revealAndroidMarker=createAndroidMarkerRevealer({map});
map.on('dragstart',()=>liveMapFollower.pause());
const splitStorageKey=()=>`itsOperatorSplit:${stackedLayout.matches?'stacked':'columns'}`;
const readSplitRatio=()=>{const saved=Number(localStorage.getItem(splitStorageKey()));return Number.isFinite(saved)&&saved>0?saved:(stackedLayout.matches ? 0.46 : 0.5)};
let mapSplitRatio=readSplitRatio(),resizingLayout=false;
function splitRatioBounds(){
  if(stackedLayout.matches){const available=Math.max(1,window.innerHeight-64);return [Math.min(.7,240/available),.8]}
  const width=operatorLayout.clientWidth,minPane=liveView?320:380;return [Math.max(.25,320/width),Math.min(.72,(width-minPane)/width)];
}
function applyLayoutSplit(save=false){
  const [minimum,maximum]=splitRatioBounds();mapSplitRatio=Math.max(minimum,Math.min(maximum,mapSplitRatio));
  operatorLayout.style.setProperty('--map-width',`${mapSplitRatio*100}%`);
  operatorLayout.style.setProperty('--map-height',`${Math.round((window.innerHeight-64)*mapSplitRatio)}px`);
  const orientation=stackedLayout.matches?'horizontal':'vertical';
  layoutSplitter.setAttribute('aria-label',liveView?'Resize map and Live View':'Resize map and menu');
  layoutSplitter.setAttribute('aria-orientation',orientation);
  layoutSplitter.setAttribute('aria-valuemin',String(Math.round(minimum*100)));
  layoutSplitter.setAttribute('aria-valuemax',String(Math.round(maximum*100)));
  layoutSplitter.setAttribute('aria-valuenow',String(Math.round(mapSplitRatio*100)));
  if(save)localStorage.setItem(splitStorageKey(),String(mapSplitRatio));
  requestAnimationFrame(()=>map.invalidateSize({pan:false}));
}
function moveLayoutSplit(event){
  const rect=operatorLayout.getBoundingClientRect();
  mapSplitRatio=stackedLayout.matches?(event.clientY-rect.top)/Math.max(1,window.innerHeight-64):(event.clientX-rect.left)/rect.width;
  applyLayoutSplit();
}
layoutSplitter.addEventListener('pointerdown',event=>{
  if(event.button!==0)return;
  resizingLayout=true;layoutSplitter.setPointerCapture(event.pointerId);document.body.classList.add('resizing-layout');event.preventDefault();
});
layoutSplitter.addEventListener('pointermove',event=>{if(resizingLayout)moveLayoutSplit(event)});
function finishLayoutResize(event){
  if(!resizingLayout)return;
  resizingLayout=false;document.body.classList.remove('resizing-layout');
  if(layoutSplitter.hasPointerCapture(event.pointerId))layoutSplitter.releasePointerCapture(event.pointerId);
  applyLayoutSplit(true);
}
layoutSplitter.addEventListener('pointerup',finishLayoutResize);
layoutSplitter.addEventListener('pointercancel',finishLayoutResize);
layoutSplitter.addEventListener('keydown',event=>{
  const [minimum,maximum]=splitRatioBounds(),step=event.shiftKey ? 0.05 : 0.02;
  if(event.key==='Home')mapSplitRatio=minimum;
  else if(event.key==='End')mapSplitRatio=maximum;
  else if(stackedLayout.matches&&event.key==='ArrowDown')mapSplitRatio+=step;
  else if(stackedLayout.matches&&event.key==='ArrowUp')mapSplitRatio-=step;
  else if(!stackedLayout.matches&&event.key==='ArrowRight')mapSplitRatio+=step;
  else if(!stackedLayout.matches&&event.key==='ArrowLeft')mapSplitRatio-=step;
  else return;
  event.preventDefault();applyLayoutSplit(true);
});
stackedLayout.addEventListener('change',()=>{mapSplitRatio=readSplitRatio();applyLayoutSplit()});
window.addEventListener('resize',()=>applyLayoutSplit());
applyLayoutSplit();
async function api(path,options={},raw=false){const requestPath=demoMode&&!raw?path.replace('/api/v1/','/api/v1/demo/'):path;const response=await fetch(requestPath,{...options,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})}});if(!response.ok)throw new Error((await response.json().catch(()=>({}))).error?.message||`HTTP ${response.status}`);return (await response.json()).data}
function sameLiveTarget(liveTarget,item){return liveTarget?.markerKey===(item?.telemetry?.external_id??null)&&liveTarget?.vehicleId===(item?.vehicleId!=null?String(item.vehicleId):null)&&liveTarget?.tripId===(item?.tripId!=null?String(item.tripId):null)}
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
function notifyLiveFrameFullscreen(fullscreen=document.fullscreenElement===livePanel){
  if(!liveView)return;
  liveFrame.contentWindow?.postMessage({type:'operator-live-view-fullscreen',fullscreen},liveView.frameOrigin);
}
function retargetLiveView(item){
  if(!liveView||sameLiveTarget(liveView,item))return;
  const frameOrigin=liveView.frameOrigin;
  releaseLiveMarker();
  liveView=createLiveView(item,frameOrigin);
  lastLiveMessage=null;
  liveMapFollower.begin(liveView);
  document.querySelector('#live-view-title').textContent=`Live View · ${liveTargetLabel(item)}`;
  renderLiveTelemetryStatus();
}
function selectVehicle(item){
  selected=item;
  details.hidden=false;
  const t=item.telemetry,r=item.plannedRoute;
  fields.replaceChildren();
  for(const [label,value] of [['Vehicle',item.vehicleName||item.vehicleCode||t.external_id],['Source',`${item.vehicleSource||'BIMS'} / ${t.telemetry_source}`],['Status',item.vehicleStatus||t.source_metadata?.state||'ACTIVE'],['Speed',`${t.speed_kmh??'—'} km/h`],['Observed',t.observed_at_utc||'—'],['Trip ID',item.tripId??'—']]){
    const term=document.createElement('dt'),description=document.createElement('dd');
    term.textContent=label;description.textContent=String(value);fields.append(term,description);
  }
  document.querySelector('#route-label').textContent=`Planned Route: ${r?.routeSource||'unavailable'}`;
  if(routeLayer){map.removeLayer(routeLayer);routeLayer=null}
  if(r?.routeGeojson)routeLayer=L.geoJSON(r.routeGeojson,{style:{color:'#ffb703',weight:5}}).addTo(map);
  document.querySelector('#recording-trip-id').value=item.tripId?String(item.tripId):'';
  if(item.tripId)void loadTripRecordings(String(item.tripId));
  retargetLiveView(item);
}
function render(snapshot){
  if(window.__virtualMode)return;
  for(const item of snapshot.vehicles){
    const t=item.telemetry,key=t.external_id,pos=[t.latitude,t.longitude];
    let entry=markers.get(key);
    if(!entry)entry=createMarkerEntry(item,pos);
    else{entry.item=item;entry.liveOnly=false}
    // A new Android stream reuses device:<vehicleId>; reveal it again when its
    // recording session changes, even though the Leaflet marker already exists.
    revealAndroidMarker(item,pos);
    const liveSelected=liveView?.markerKey===key;
    entry.marker.setStyle(liveSelected?LIVE_MARKER_STYLE:fleetMarkerStyle(item));
    entry.marker.setRadius(liveSelected||isAndroidGpsItem(item)?10:8);
    // Live frames own the selected marker between successful fleet polls.
    if(!isLiveOverride(liveView,key,Date.now())){
      entry.marker.setLatLng(pos);
      if(liveView?.markerKey===key&&liveMapFollower.isFollowing())liveMapFollower.update(pos);
    }
    const session=t.source_metadata?.recordingSessionId;
    // A new stream session supersedes the old one; reject its late frames.
    if(liveView?.markerKey===key&&typeof session==='string'&&session!==liveView.recordingSessionId)liveView.recordingSessionId=session;
    entry.marker.bindTooltip(isAndroidGpsItem(item)?`Android GPS · ${item.vehicleCode||key}`:item.vehicleCode||key);
  }
}
async function refresh(){try{render(await api('/api/v1/tracking/vehicles'));error.textContent='';document.querySelector('#connection').textContent='Tracking connected'}catch(e){error.textContent=e.message;document.querySelector('#connection').textContent='Tracking unavailable'}}
async function loadTripAssignments(){
  const [vehicles,trips]=await Promise.all([api('/api/v1/vehicles',{},true),api('/api/v1/trips',{},true)]);
  const vehicleSelect=document.querySelector('#trip-vehicle'),previousVehicle=vehicleSelect.value;
  vehicleSelect.replaceChildren(new Option('Select a vehicle',''));
  for(const vehicle of vehicles.filter(item=>item.isActive)){
    const label=[`Vehicle ${vehicle.vehicleId}`,vehicle.vehicleCode,vehicle.vehicleName,vehicle.vehicleStatus].filter(Boolean).join(' · ');
    vehicleSelect.add(new Option(label,String(vehicle.vehicleId)));
  }
  if(vehicles.some(item=>item.isActive&&String(item.vehicleId)===previousVehicle))vehicleSelect.value=previousVehicle;
  const list=document.querySelector('#trips-list');list.replaceChildren();
  for(const trip of trips){
    const row=document.createElement('li'),title=document.createElement('strong'),vehicle=document.createElement('span'),destination=document.createElement('span'),status=document.createElement('span');
    title.textContent=`Trip ID ${trip.tripId}`;
    vehicle.textContent=`Vehicle ID ${trip.vehicleId} · ${trip.vehicle.vehicleCode}${trip.vehicle.vehicleName?` · ${trip.vehicle.vehicleName}`:''}`;
    destination.textContent=`${trip.originName?`${trip.originName} → `:''}${trip.destinationName}`;
    status.textContent=`${trip.tripStatus}${trip.plannedStartAt?` · planned ${new Date(trip.plannedStartAt).toLocaleString()}`:''}`;
    row.append(title,vehicle,destination,status);list.append(row);
  }
  if(!vehicles.some(item=>item.isActive))vehicleSelect.replaceChildren(new Option('No active vehicles available',''));
  if(!trips.length){const empty=document.createElement('li');empty.textContent='No trips created yet.';list.append(empty)}
}
async function start(role){
  currentRole=demoMode?'':(role||'');
  updateRecordingDeleteTools();
  document.querySelector('#login').hidden=!demoMode;
  bootstrap=await api('/api/v1/bootstrap');
  document.querySelector('#trip-panel').hidden=demoMode;
  if(!demoMode){
    document.querySelector('#trip-form').hidden=!['ADMIN','OPERATOR'].includes(role);
    document.querySelector('#trip-status-message').textContent=['ADMIN','OPERATOR'].includes(role)?'Choose a vehicle and destination.':'You can review recent trips; an operator or admin can create one.';
    await loadTripAssignments();
  }
  await refresh();
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
function stopRecordingPlayback(){const player=replayPlayer();replayGeneration++;replaySeekGeneration++;replayScrubbing=false;replayScrubWasPlaying=false;replaySeekPending=false;player.pause();player.removeAttribute('src');player.load();replayIndex=-1;clearReplayOverlay();document.querySelector('#recording-play').textContent='Play';document.querySelector('#recording-time').textContent=`0:00 / ${formatReplayTime(replayDuration)}`;document.querySelector('#recording-seek').value='0'}
function setReplayPosition(value){const position=Math.max(0,Math.min(replayDuration,Number(value)||0));document.querySelector('#recording-seek').value=String(position);document.querySelector('#recording-time').textContent=`${formatReplayTime(position)} / ${formatReplayTime(replayDuration)}`}
function renderReplayBreakMarkers(){const markers=document.querySelector('#recording-break-markers');markers.replaceChildren();for(const entry of replayTimeline){if(entry.breakBefore){const marker=document.createElement('span');marker.style.left=`${replayDuration?entry.start/replayDuration*100:0}%`;marker.title=`Recording break before segment ${entry.video.segmentIndex}`;markers.append(marker)}}}
function updateRecordingDeleteTools(){document.querySelector('#recording-delete-tools').hidden=!['ADMIN','OPERATOR'].includes(currentRole)||!replayTimeline.length}
function clearRecordingDeleteSelection(){document.querySelector('#recording-delete-selection').hidden=true;document.querySelector('#recording-delete-selected').disabled=true;document.querySelector('#recording-delete-selection-status').textContent='No segments selected.';recordingDeleteRange=null;recordingDeleteDrag=null}
function openRecordingDeleteMode(){if(!replayTimeline.length)return;renderRecordingDeleteTimeline();document.querySelector('#recording-delete-mode').hidden=false;document.querySelector('#recording-timeline').classList.add('is-delete-mode');document.querySelector('#recording-seek').disabled=true;document.querySelector('#recording-delete-range').hidden=false;replayPlayer().pause();document.querySelector('#recording-delete-toggle').textContent='Exit delete mode';document.querySelector('#recording-delete-range').focus()}
function closeRecordingDeleteMode(){document.querySelector('#recording-delete-mode').hidden=true;document.querySelector('#recording-delete-toggle').textContent='Delete segments';document.querySelector('#recording-timeline').classList.remove('is-delete-mode');document.querySelector('#recording-seek').disabled=false;document.querySelector('#recording-delete-range').hidden=true;document.querySelector('#recording-delete-segments').replaceChildren();clearRecordingDeleteSelection()}
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
function syncReplayFullscreenButton(){const isFullscreen=document.fullscreenElement===replayPanel;replayFullscreenButton.textContent=isFullscreen?'Exit full screen':'Full screen';replayFullscreenButton.setAttribute('aria-label',isFullscreen?'Exit full-screen replay':'View replay full screen')}
if(!document.fullscreenEnabled||typeof replayPanel.requestFullscreen!=='function')replayFullscreenButton.hidden=true;
else{replayFullscreenButton.addEventListener('click',async()=>{try{if(document.fullscreenElement===replayPanel)await document.exitFullscreen();else await replayPanel.requestFullscreen()}catch{document.querySelector('#recordings-status').textContent='Full-screen replay is unavailable in this browser.'}});document.addEventListener('fullscreenchange',()=>{syncReplayFullscreenButton();requestAnimationFrame(()=>drawReplayOverlay())});syncReplayFullscreenButton()}
window.addEventListener('resize',()=>drawReplayOverlay());
replayPlayer().addEventListener('timeupdate',()=>{if(replayIndex<0||replayScrubbing||replaySeekPending)return;setReplayPosition(replayTimeline[replayIndex].start+replayPlayer().currentTime)});
replayPlayer().addEventListener('loadedmetadata',()=>drawReplayOverlay());
replayPlayer().addEventListener('seeked',()=>drawReplayOverlay());
replayPlayer().addEventListener('ended',()=>{stopReplayOverlayFrameLoop();if(replayIndex<0)return;const next=replayTimeline.findIndex((entry,index)=>index>replayIndex&&!entry.unavailable);if(next>=0)void seekReplay(replayTimeline[next].start,true,1,next);else document.querySelector('#recordings-status').textContent='Trip replay finished.'});
replayPlayer().addEventListener('error',()=>{if(replayIndex<0||replayPlayer().readyState<1)return;const failedIndex=replayIndex,entry=replayTimeline[failedIndex];entry.unavailable=true;renderReplayBreakMarkers();document.querySelector('#recordings-status').textContent=`Playback failed for segment ${entry.video.segmentIndex}; skipping to the next segment.`;const next=replayTimeline.findIndex((item,index)=>index>failedIndex&&!item.unavailable);if(next>=0)void seekReplay(replayTimeline[next].start,true,1,next)});
replayPlayer().addEventListener('play',()=>{document.querySelector('#recording-play').textContent='Pause';startReplayOverlayFrameLoop()});
replayPlayer().addEventListener('pause',()=>{document.querySelector('#recording-play').textContent='Play';stopReplayOverlayFrameLoop();drawReplayOverlay()});
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
document.querySelector('#login').addEventListener('submit',async e=>{e.preventDefault();try{const f=new FormData(e.currentTarget),result=await api('/api/v1/auth/login',{method:'POST',body:JSON.stringify(Object.fromEntries(f))},true);token=result.accessToken;sessionStorage.setItem('itsToken',token);demoMode=false;await start(result.user.role)}catch(ex){error.textContent=ex.message}});
function browserReachableUrl(configuredUrl){
  const url=new URL(configuredUrl,window.location.href);
  if(url.hostname==='127.0.0.1'||url.hostname==='localhost')url.hostname=window.location.hostname;
  return url.href;
}
function renderLiveTelemetryStatus(){
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
  liveView=null;lastLiveMessage=null;
  document.querySelector('#live-view-title').textContent='Live View';
  clearInterval(liveStatusTimer);liveStatusTimer=undefined;
  applyLayoutSplit();
  document.querySelector('#live-view').focus({preventScroll:true});
  renderLiveTelemetryStatus();
}
window.addEventListener('message',event=>{
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
  if(!bootstrap||!selected)return;
  const liveViewUrlObject=new URL(browserReachableUrl(bootstrap.liveViewUrl));
  liveViewUrlObject.searchParams.set('autostart','1');
  const liveViewUrl=liveViewUrlObject.href;
  const diagnostic=document.querySelector('#live-view-diagnostic');
  diagnostic.textContent=`Live View origin: ${new URL(liveViewUrl).origin}`;
  if(!window.isSecureContext)diagnostic.textContent+=' — dashboard is not a secure context; open its HTTPS URL';
  liveView=createLiveView(selected,new URL(liveViewUrl).origin);lastLiveMessage=null;
  liveMapFollower.begin(liveView);
  document.querySelector('#live-view-title').textContent=`Live View · ${liveTargetLabel(selected)}`;
  clearInterval(liveStatusTimer);liveStatusTimer=setInterval(renderLiveTelemetryStatus,1000);
  renderLiveTelemetryStatus();
  operatorLayout.classList.add('live-view-open');
  livePanel.hidden=false;
  applyLayoutSplit();
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
function syncLiveFullscreenButton(){const fullscreen=document.fullscreenElement===livePanel;liveFullscreenButton.textContent=fullscreen?'Exit full screen':'Full screen';liveFullscreenButton.setAttribute('aria-label',fullscreen?'Exit full-screen Live View':'View Live View full screen')}
if(!document.fullscreenEnabled||typeof livePanel.requestFullscreen!=='function')liveFullscreenButton.hidden=true;
else{
  liveFullscreenButton.addEventListener('click',async()=>{try{if(document.fullscreenElement===livePanel)await document.exitFullscreen();else await livePanel.requestFullscreen()}catch{document.querySelector('#live-view-diagnostic').textContent='Full-screen Live View is unavailable in this browser.'}});
  document.addEventListener('fullscreenchange',()=>{syncLiveFullscreenButton();notifyLiveFrameFullscreen();requestAnimationFrame(()=>map.invalidateSize({pan:false}))});
  syncLiveFullscreenButton();
}
document.querySelectorAll('[data-trip-map-pick]').forEach(button=>button.addEventListener('click',()=>{
  tripMapPick=button.dataset.tripMapPick;
  document.querySelectorAll('[data-trip-map-pick]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));
  map.getContainer().style.cursor='crosshair';
  document.querySelector('#trip-status-message').textContent=`Click the map to set the ${tripMapPick} coordinates.`;
}));
map.on('click',event=>{
  if(!tripMapPick)return;
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
});
document.querySelector('#trip-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const form=event.currentTarget,button=document.querySelector('#create-trip'),message=document.querySelector('#trip-status-message');
  const value=id=>document.querySelector(`#${id}`).value.trim();
  const originLatitude=value('trip-origin-latitude'),originLongitude=value('trip-origin-longitude');
  if(Boolean(originLatitude)!==Boolean(originLongitude)){message.textContent='Enter both origin coordinates, or leave both empty.';return}
  const body={vehicleId:value('trip-vehicle'),destinationName:value('trip-destination-name'),destinationLatitude:Number(value('trip-destination-latitude')),destinationLongitude:Number(value('trip-destination-longitude')),tripStatus:value('trip-status')};
  for(const [field,id] of [['originName','trip-origin-name'],['destinationAddress','trip-destination-address']])if(value(id))body[field]=value(id);
  if(originLatitude){body.originLatitude=Number(originLatitude);body.originLongitude=Number(originLongitude)}
  if(value('trip-planned-start'))body.plannedStartAt=new Date(value('trip-planned-start')).toISOString();
  button.disabled=true;message.textContent='Creating trip…';
  try{
    const trip=await api('/api/v1/trips',{method:'POST',body:JSON.stringify(body)},true);
    message.textContent=`Created Trip ID ${trip.tripId} for Vehicle ID ${trip.vehicleId}. Enter both IDs in the Android app.`;
    document.querySelector('#recording-trip-id').value=String(trip.tripId);
    await Promise.all([loadTripAssignments(),loadTripRecordings(String(trip.tripId))]);
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
  try{await start()}catch(ex){demoMode=false;document.querySelector('#login').hidden=false;document.querySelector('#connection').textContent='Signed out';error.textContent=ex.message}
}
boot().catch(e=>error.textContent=e.message);
