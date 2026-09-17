import {buildReplayTimeline,detectionSampleAtPts,entryForTime,segmentDuration} from './replay-timeline.js';
const map=L.map('map').setView([35.1796,129.0756],12);
L.tileLayer('/osm/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap contributors'}).addTo(map);
const markers=new Map(),tripMapMarkers=new Map();let token=sessionStorage.getItem('itsToken');let bootstrap;let selected;let routeLayer;let demoMode=false;let recordingsRequest=0;let refreshTimer;let tripMapPick;let replayTimeline=[];let replayDuration=0;let replayIndex=-1;let replayGeneration=0;let replayTripId='';
const error=document.querySelector('#error'),details=document.querySelector('#details'),fields=document.querySelector('#fields');
const operatorLayout=document.querySelector('#operator-layout'),layoutSplitter=document.querySelector('#layout-splitter'),stackedLayout=window.matchMedia('(max-width: 1000px)');
const splitStorageKey=()=>`itsOperatorSplit:${stackedLayout.matches?'stacked':'columns'}`;
const readSplitRatio=()=>{const saved=Number(localStorage.getItem(splitStorageKey()));return Number.isFinite(saved)&&saved>0?saved:(stackedLayout.matches ? 0.46 : 0.5)};
let mapSplitRatio=readSplitRatio(),resizingLayout=false;
function splitRatioBounds(){
  if(stackedLayout.matches){const available=Math.max(1,window.innerHeight-64);return [Math.min(.7,280/available),.8]}
  const width=operatorLayout.clientWidth;return [Math.max(.25,320/width),Math.min(.72,(width-390)/width)];
}
function applyLayoutSplit(save=false){
  const [minimum,maximum]=splitRatioBounds();mapSplitRatio=Math.max(minimum,Math.min(maximum,mapSplitRatio));
  operatorLayout.style.setProperty('--map-width',`${mapSplitRatio*100}%`);
  operatorLayout.style.setProperty('--map-height',`${Math.round((window.innerHeight-64)*mapSplitRatio)}px`);
  const orientation=stackedLayout.matches?'horizontal':'vertical';
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
function selectVehicle(item){selected=item;details.hidden=false;const t=item.telemetry,r=item.plannedRoute;fields.replaceChildren();for(const [label,value] of [['Vehicle',item.vehicleName||item.vehicleCode||t.external_id],['Source',`${item.vehicleSource||'BIMS'} / ${t.telemetry_source}`],['Status',item.vehicleStatus||t.source_metadata?.state||'ACTIVE'],['Speed',`${t.speed_kmh??'—'} km/h`],['Observed',t.observed_at_utc||'—'],['Trip ID',item.tripId??'—']]){const term=document.createElement('dt'),description=document.createElement('dd');term.textContent=label;description.textContent=String(value);fields.append(term,description)}document.querySelector('#route-label').textContent=`Planned Route: ${r?.routeSource||'unavailable'}`;if(routeLayer){map.removeLayer(routeLayer);routeLayer=null}if(r?.routeGeojson){routeLayer=L.geoJSON(r.routeGeojson,{style:{color:'#ffb703',weight:5}}).addTo(map)}document.querySelector('#recording-trip-id').value=item.tripId?String(item.tripId):'';if(item.tripId)void loadTripRecordings(String(item.tripId))}
function render(snapshot){for(const item of snapshot.vehicles){const t=item.telemetry,key=t.external_id,pos=[t.latitude,t.longitude];let entry=markers.get(key);if(!entry){const marker=L.circleMarker(pos,{radius:8,color:'#fff',fillColor:'#16c79a',fillOpacity:.9}).addTo(map);entry={marker,item};marker.on('click',()=>selectVehicle(entry.item));markers.set(key,entry)}else{entry.item=item;entry.marker.setLatLng(pos)}entry.marker.bindTooltip(item.vehicleCode||key)}}
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
function formatReplayGap(value){const seconds=Math.max(0,Number(value)||0);return seconds<60?`${seconds.toFixed(1)}s`:formatReplayTime(seconds)}
function formatRecording(video){const started=video.startedAt?new Date(video.startedAt).toLocaleString():'Time unavailable';const duration=segmentDuration(video);const size=video.sizeBytes?`${(Number(video.sizeBytes)/1024/1024).toFixed(1)} MB`:'size unavailable';return `Segment ${video.segmentIndex} · ${started} · ${formatReplayTime(duration)} · ${size}`}
function clearReplayOverlay(){const canvas=document.querySelector('#recording-overlay'),context=canvas.getContext('2d');context.clearRect(0,0,canvas.width,canvas.height)}
function stopRecordingPlayback(){const player=replayPlayer();replayGeneration++;player.pause();player.removeAttribute('src');player.load();replayIndex=-1;clearReplayOverlay();document.querySelector('#recording-play').textContent='Play';document.querySelector('#recording-time').textContent=`0:00 / ${formatReplayTime(replayDuration)}`;document.querySelector('#recording-seek').value='0'}
function setReplayPosition(value){const position=Math.max(0,Math.min(replayDuration,Number(value)||0));document.querySelector('#recording-seek').value=String(position);document.querySelector('#recording-time').textContent=`${formatReplayTime(position)} / ${formatReplayTime(replayDuration)}`}
function renderReplayList(){const list=document.querySelector('#recordings-list'),breaks=document.querySelector('#recording-breaks'),markers=document.querySelector('#recording-break-markers');list.replaceChildren();breaks.replaceChildren();markers.replaceChildren();for(const [index,entry] of replayTimeline.entries()){if(entry.breakBefore){const note=document.createElement('span');const gap=Math.max(0,entry.wallGapSeconds);note.textContent=`Break before segment ${entry.video.segmentIndex}: ${formatReplayGap(gap)} unrecorded`;breaks.append(note,document.createElement('br'));const marker=document.createElement('span');marker.style.left=`${replayDuration?entry.start/replayDuration*100:0}%`;marker.title=`Recording break before segment ${entry.video.segmentIndex}`;markers.append(marker)}const row=document.createElement('li'),description=document.createElement('span'),button=document.createElement('button');description.textContent=formatRecording(entry.video);button.type='button';button.textContent=entry.unavailable?'Retry segment':'Go to segment';button.addEventListener('click',()=>{entry.unavailable=false;void seekReplay(entry.start,true,1,index)});row.append(description,button);list.append(row)}}
function waitForVideoMetadata(player){return new Promise((resolve,reject)=>{const loaded=()=>{cleanup();resolve()},failed=()=>{cleanup();reject(new Error('The recording video could not be loaded'))},cleanup=()=>{player.removeEventListener('loadedmetadata',loaded);player.removeEventListener('error',failed)};if(player.readyState>=1){resolve();return}player.addEventListener('loadedmetadata',loaded,{once:true});player.addEventListener('error',failed,{once:true})})}
function loadReplayDetections(entry){if(entry.samplesLoaded)return Promise.resolve();if(entry.sampleLoadPromise)return entry.sampleLoadPromise;entry.sampleLoadPromise=api(`/api/v1/trips/${encodeURIComponent(replayTripId)}/videos/${encodeURIComponent(entry.video.tripVideoId)}/detections`,{},true).then(result=>{entry.samples=result.samples||[];entry.coverageIncomplete=Boolean(result.coverageIncomplete)}).catch(()=>{entry.samples=[];entry.coverageIncomplete=true}).finally(()=>{entry.samplesLoaded=true;entry.sampleLoadPromise=null;renderReplayList();if(replayTimeline[replayIndex]===entry)drawReplayOverlay()});return entry.sampleLoadPromise}
async function activateReplaySegment(index,localTime,autoplay,generation){const entry=replayTimeline[index],player=replayPlayer();if(!entry||entry.unavailable)throw new Error('This recording segment is unavailable');const switchSegment=replayIndex!==index||!player.currentSrc,urlPromise=switchSegment?api(`/api/v1/trip-videos/${encodeURIComponent(entry.video.tripVideoId)}/playback-url`,{method:'POST'},true):Promise.resolve({url:entry.playbackUrl});const [url]=await Promise.all([urlPromise,loadReplayDetections(entry)]);if(generation!==replayGeneration)return false;if(switchSegment){entry.playbackUrl=url.url;player.src=url.url;player.load();await waitForVideoMetadata(player);if(generation!==replayGeneration)return false}replayIndex=index;const safeDuration=Number.isFinite(player.duration)?player.duration:entry.duration;player.currentTime=Math.min(Math.max(0,localTime),Math.max(0,safeDuration-.02));setReplayPosition(entry.start+player.currentTime);if(autoplay)await player.play();drawReplayOverlay();return true}
async function seekReplay(position,autoplay=true,direction=1,preferredIndex=-1){if(!replayTimeline.length)return;const generation=++replayGeneration,player=replayPlayer();player.pause();let target=Math.max(0,Math.min(replayDuration,Number(position)||0));let index=preferredIndex>=0?preferredIndex:entryForTime(replayTimeline,replayDuration,target,direction);if(index<0)index=direction<0?replayTimeline.length-1:0;for(let attempt=0;attempt<replayTimeline.length;attempt++){const entry=replayTimeline[index];if(entry.unavailable){index+=direction;if(index<0||index>=replayTimeline.length)break;target=replayTimeline[index].start;continue}try{const ok=await activateReplaySegment(index,Math.max(0,target-entry.start),autoplay,generation);if(!ok)return;document.querySelector('#recordings-status').textContent=`Playing trip timeline · segment ${entry.video.segmentIndex} of ${replayTimeline.length}.`;return}catch(ex){if(generation!==replayGeneration)return;entry.unavailable=true;renderReplayList();document.querySelector('#recordings-status').textContent=`Segment ${entry.video.segmentIndex} is unavailable (${ex.message}); skipping to the next segment.`;index+=direction;if(index<0||index>=replayTimeline.length)break;target=replayTimeline[index].start}}player.pause();document.querySelector('#recordings-status').textContent='No playable recording segments remain in this direction.'}
async function loadTripRecordings(value){const requestId=++recordingsRequest;const tripId=String(value||'').trim(),list=document.querySelector('#recordings-list'),status=document.querySelector('#recordings-status');list.replaceChildren();replayTimeline=[];replayDuration=0;replayTripId=tripId;document.querySelector('#recording-breaks').replaceChildren();stopRecordingPlayback();document.querySelector('#recording-player-panel').hidden=true;if(!/^[1-9][0-9]{0,18}$/.test(tripId)){status.textContent='Select a vehicle with a trip or enter a positive Trip ID.';return}status.textContent=`Loading trip ${tripId}…`;try{await requireRecordingLogin();const videos=await api(`/api/v1/trips/${encodeURIComponent(tripId)}/videos`,{},true);if(requestId!==recordingsRequest)return;if(!videos.length){status.textContent=`No finalized recording segments are available for trip ${tripId}.`;return}const timeline=buildReplayTimeline(videos);replayTimeline=timeline.entries;replayDuration=timeline.duration;if(!replayTimeline.length){status.textContent=`Trip ${tripId} has no segments with a usable duration.`;return}document.querySelector('#recording-player-panel').hidden=false;const seek=document.querySelector('#recording-seek');seek.max=String(replayDuration);seek.value='0';document.querySelector('#recording-time').textContent=`0:00 / ${formatReplayTime(replayDuration)}`;renderReplayList();status.textContent=`Trip ${tripId}: ${replayTimeline.length} segments, ${formatReplayTime(replayDuration)} total. Loading detections as segments play.`;await seekReplay(0,false)}catch(ex){if(requestId!==recordingsRequest)return;status.textContent=ex.message}}
function drawReplayOverlay(){const canvas=document.querySelector('#recording-overlay'),player=replayPlayer(),entry=replayTimeline[replayIndex];if(!entry||player.videoWidth<=0||player.videoHeight<=0){clearReplayOverlay();return}const rect=canvas.getBoundingClientRect(),ratio=window.devicePixelRatio||1;if(canvas.width!==Math.round(rect.width*ratio)||canvas.height!==Math.round(rect.height*ratio)){canvas.width=Math.round(rect.width*ratio);canvas.height=Math.round(rect.height*ratio)}const context=canvas.getContext('2d');context.clearRect(0,0,canvas.width,canvas.height);context.setTransform(ratio,0,0,ratio,0,0);const localPts=BigInt(entry.video.startPts90k)+BigInt(Math.round(player.currentTime*90000)),sample=detectionSampleAtPts(entry.samples,localPts);const overlayStatus=document.querySelector('#recording-overlay-status');overlayStatus.textContent=entry.coverageIncomplete?`Detection coverage is incomplete for segment ${entry.video.segmentIndex}.`:`Detection overlay · segment ${entry.video.segmentIndex}`;if(!sample||!sample.detections?.length)return;const scale=Math.min(rect.width/player.videoWidth,rect.height/player.videoHeight),drawWidth=player.videoWidth*scale,drawHeight=player.videoHeight*scale,left=(rect.width-drawWidth)/2,top=(rect.height-drawHeight)/2;context.lineWidth=2;context.font='bold 12px system-ui, sans-serif';for(const detection of sample.detections){const [x1,y1,x2,y2]=detection.bbox||[];if(![x1,y1,x2,y2].every(Number.isFinite))continue;const x=left+x1*drawWidth,y=top+y1*drawHeight,w=Math.max(1,(x2-x1)*drawWidth),h=Math.max(1,(y2-y1)*drawHeight);context.strokeStyle='#35e69b';context.strokeRect(x,y,w,h);const label=`${detection.class} ${Number(detection.confidence).toFixed(2)}`;const labelWidth=context.measureText(label).width+8;context.fillStyle='#04251de8';context.fillRect(x,Math.max(top,y-19),labelWidth,18);context.fillStyle='#eafff5';context.fillText(label,x+4,Math.max(top+13,y-6))}}
window.addEventListener('resize',drawReplayOverlay);
replayPlayer().addEventListener('timeupdate',()=>{if(replayIndex<0)return;setReplayPosition(replayTimeline[replayIndex].start+replayPlayer().currentTime);drawReplayOverlay()});
replayPlayer().addEventListener('loadedmetadata',drawReplayOverlay);
replayPlayer().addEventListener('ended',()=>{if(replayIndex<0)return;const next=replayTimeline.findIndex((entry,index)=>index>replayIndex&&!entry.unavailable);if(next>=0)void seekReplay(replayTimeline[next].start,true,1,next);else document.querySelector('#recordings-status').textContent='Trip replay finished.'});
replayPlayer().addEventListener('error',()=>{if(replayIndex<0||replayPlayer().readyState<1)return;const failedIndex=replayIndex,entry=replayTimeline[failedIndex];entry.unavailable=true;renderReplayList();document.querySelector('#recordings-status').textContent=`Playback failed for segment ${entry.video.segmentIndex}; skipping to the next segment.`;const next=replayTimeline.findIndex((item,index)=>index>failedIndex&&!item.unavailable);if(next>=0)void seekReplay(replayTimeline[next].start,true,1,next)});
replayPlayer().addEventListener('play',()=>document.querySelector('#recording-play').textContent='Pause');
replayPlayer().addEventListener('pause',()=>document.querySelector('#recording-play').textContent='Play');
document.querySelector('#recording-play').addEventListener('click',()=>{const player=replayPlayer();if(!replayTimeline.length)return;if(!player.paused){player.pause();return}if(replayIndex<0)void seekReplay(0,true);else void player.play()});
document.querySelector('#recording-back').addEventListener('click',()=>void seekReplay(replayCurrentTime()-10,true,-1));
document.querySelector('#recording-forward').addEventListener('click',()=>void seekReplay(replayCurrentTime()+10,true,1));
document.querySelector('#recording-seek').addEventListener('input',event=>setReplayPosition(event.currentTarget.value));
document.querySelector('#recording-seek').addEventListener('change',event=>void seekReplay(event.currentTarget.value,true,1));
document.querySelector('#recordings-form').addEventListener('submit',event=>{event.preventDefault();void loadTripRecordings(document.querySelector('#recording-trip-id').value)});
document.querySelector('#stop-recording').addEventListener('click',stopRecordingPlayback);
document.querySelector('#login').addEventListener('submit',async e=>{e.preventDefault();try{const f=new FormData(e.currentTarget),result=await api('/api/v1/auth/login',{method:'POST',body:JSON.stringify(Object.fromEntries(f))},true);token=result.accessToken;sessionStorage.setItem('itsToken',token);demoMode=false;await start(result.user.role)}catch(ex){error.textContent=ex.message}});
function browserReachableUrl(configuredUrl){
  const url=new URL(configuredUrl,window.location.href);
  if(url.hostname==='127.0.0.1'||url.hostname==='localhost')url.hostname=window.location.hostname;
  return url.href;
}
function stopLiveView(){
  const panel=document.querySelector('#live-view-panel');
  const frame=document.querySelector('#live-view-frame');
  // Navigating the iframe away from the Vision page closes its WebRTC peer
  // connection and releases the browser media resources.
  frame.src='about:blank';
  panel.hidden=true;
  document.querySelector('#live-view-diagnostic').textContent='';
}
document.querySelector('#live-view').addEventListener('click',()=>{
  if(!bootstrap)return;
  const liveViewUrlObject=new URL(browserReachableUrl(bootstrap.liveViewUrl));
  liveViewUrlObject.searchParams.set('autostart','1');
  const liveViewUrl=liveViewUrlObject.href;
  const diagnostic=document.querySelector('#live-view-diagnostic');
  diagnostic.textContent=`Live View origin: ${new URL(liveViewUrl).origin}`;
  if(!window.isSecureContext)diagnostic.textContent+=' — dashboard is not a secure context; open its HTTPS URL';
  document.querySelector('#live-view-panel').hidden=false;
  // Set the URL only after opening the panel so navigation/playback starts as
  // part of the user's click instead of while the iframe is hidden.
  document.querySelector('#live-view-frame').src=liveViewUrl;
});
document.querySelector('#live-view-frame').addEventListener('load',event=>{
  if(document.querySelector('#live-view-panel').hidden)return;
  const diagnostic=document.querySelector('#live-view-diagnostic');
  try{
    diagnostic.textContent+=event.currentTarget.contentWindow.isSecureContext?' — secure context ready':' — iframe is not a secure context';
  }catch{
    diagnostic.textContent+=' — iframe loaded; inspect its console if playback does not start';
  }
});
document.querySelector('#close-live-view').addEventListener('click',stopLiveView);
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
