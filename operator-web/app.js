const map=L.map('map').setView([35.1796,129.0756],12);
L.tileLayer('/osm/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap contributors'}).addTo(map);
const markers=new Map(),tripMapMarkers=new Map();let token=sessionStorage.getItem('itsToken');let bootstrap;let selected;let routeLayer;let demoMode=false;let recordingsRequest=0;let refreshTimer;let tripMapPick;
const error=document.querySelector('#error'),details=document.querySelector('#details'),fields=document.querySelector('#fields');
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
function stopRecordingPlayback(){const player=document.querySelector('#recording-player');player.pause();player.removeAttribute('src');player.load();document.querySelector('#recording-player-panel').hidden=true}
function formatRecording(video){const started=video.startedAt?new Date(video.startedAt).toLocaleString():'Time unavailable';const duration=video.durationSec==null?'duration unavailable':`${video.durationSec}s`;const size=video.sizeBytes?`${(Number(video.sizeBytes)/1024/1024).toFixed(1)} MB`:'size unavailable';return `Segment ${video.segmentIndex} · ${started} · ${duration} · ${size}`}
async function loadTripRecordings(value){const requestId=++recordingsRequest;const tripId=String(value||'').trim();const list=document.querySelector('#recordings-list'),status=document.querySelector('#recordings-status');list.replaceChildren();stopRecordingPlayback();if(!/^[1-9][0-9]{0,18}$/.test(tripId)){status.textContent='Select a vehicle with a trip or enter a positive Trip ID.';return}status.textContent=`Loading trip ${tripId}…`;try{await requireRecordingLogin();const videos=await api(`/api/v1/trips/${encodeURIComponent(tripId)}/videos`,{},true);if(requestId!==recordingsRequest)return;if(!videos.length){status.textContent=`No finalized recording segments are available for trip ${tripId}.`;return}status.textContent=`${videos.length} finalized segment${videos.length===1?'':'s'} for trip ${tripId}.`;for(const video of videos){const row=document.createElement('li'),description=document.createElement('span'),button=document.createElement('button');description.textContent=formatRecording(video);button.type='button';button.textContent='Play';button.addEventListener('click',()=>playTripRecording(video));row.append(description,button);list.append(row)}}catch(ex){if(requestId!==recordingsRequest)return;status.textContent=ex.message}}
async function playTripRecording(video){const status=document.querySelector('#recordings-status'),player=document.querySelector('#recording-player');status.textContent=`Requesting playback for segment ${video.segmentIndex}…`;try{await requireRecordingLogin();const result=await api(`/api/v1/trip-videos/${encodeURIComponent(video.tripVideoId)}/playback-url`,{method:'POST'},true);player.src=result.url;document.querySelector('#recording-player-panel').hidden=false;player.load();status.textContent=`Playing segment ${result.segmentIndex}. The private playback URL expires at ${new Date(result.expiresAt).toLocaleTimeString()}.`;try{await player.play()}catch{status.textContent+=' Press Play in the video controls to start.'}}catch(ex){status.textContent=ex.message}}
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
