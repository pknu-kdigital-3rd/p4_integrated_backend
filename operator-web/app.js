const map=L.map('map').setView([35.1796,129.0756],12);
L.tileLayer('/osm/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap contributors'}).addTo(map);
const markers=new Map();let token=sessionStorage.getItem('itsToken');let bootstrap;let selected;let routeLayer;let demoMode=false;let recordingsRequest=0;
const error=document.querySelector('#error'),details=document.querySelector('#details'),fields=document.querySelector('#fields');
async function api(path,options={},raw=false){const requestPath=demoMode&&!raw?path.replace('/api/v1/','/api/v1/demo/'):path;const response=await fetch(requestPath,{...options,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})}});if(!response.ok)throw new Error((await response.json().catch(()=>({}))).error?.message||`HTTP ${response.status}`);return (await response.json()).data}
function selectVehicle(item){selected=item;details.hidden=false;const t=item.telemetry,r=item.plannedRoute;fields.replaceChildren();for(const [label,value] of [['Vehicle',item.vehicleName||item.vehicleCode||t.external_id],['Source',`${item.vehicleSource||'BIMS'} / ${t.telemetry_source}`],['Status',item.vehicleStatus||t.source_metadata?.state||'ACTIVE'],['Speed',`${t.speed_kmh??'—'} km/h`],['Observed',t.observed_at_utc||'—'],['Trip ID',item.tripId??'—']]){const term=document.createElement('dt'),description=document.createElement('dd');term.textContent=label;description.textContent=String(value);fields.append(term,description)}document.querySelector('#route-label').textContent=`Planned Route: ${r?.routeSource||'unavailable'}`;if(routeLayer){map.removeLayer(routeLayer);routeLayer=null}if(r?.routeGeojson){routeLayer=L.geoJSON(r.routeGeojson,{style:{color:'#ffb703',weight:5}}).addTo(map)}document.querySelector('#recording-trip-id').value=item.tripId?String(item.tripId):'';void loadTripRecordings(item.tripId?String(item.tripId):'')}
function render(snapshot){for(const item of snapshot.vehicles){const t=item.telemetry,key=t.external_id,pos=[t.latitude,t.longitude];let entry=markers.get(key);if(!entry){const marker=L.circleMarker(pos,{radius:8,color:'#fff',fillColor:'#16c79a',fillOpacity:.9}).addTo(map);entry={marker,item};marker.on('click',()=>selectVehicle(entry.item));markers.set(key,entry)}else{entry.item=item;entry.marker.setLatLng(pos)}entry.marker.bindTooltip(item.vehicleCode||key)}}
async function refresh(){try{render(await api('/api/v1/tracking/vehicles'));error.textContent='';document.querySelector('#connection').textContent='Tracking connected'}catch(e){error.textContent=e.message;document.querySelector('#connection').textContent='Tracking unavailable'}}
async function start(){document.querySelector('#login').hidden=true;bootstrap=await api('/api/v1/bootstrap');await refresh();setInterval(refresh,3000)}
async function autoLogin(){
  if(token)return true;
  try{
    const result=await api('/api/v1/auth/login',{method:'POST',body:JSON.stringify({loginId:'admin',password:'admin1234'})},true);
    token=result.accessToken;
    sessionStorage.setItem('itsToken',token);
    return true;
  }catch(ex){
    error.textContent=`Automatic login failed: ${ex.message}`;
    return false;
  }
}
async function requireRecordingLogin(){if(token)return;if(demoMode&&await autoLogin())return;throw new Error('Sign in before accessing trip recordings')}
function stopRecordingPlayback(){const player=document.querySelector('#recording-player');player.pause();player.removeAttribute('src');player.load();document.querySelector('#recording-player-panel').hidden=true}
function formatRecording(video){const started=video.startedAt?new Date(video.startedAt).toLocaleString():'Time unavailable';const duration=video.durationSec==null?'duration unavailable':`${video.durationSec}s`;const size=video.sizeBytes?`${(Number(video.sizeBytes)/1024/1024).toFixed(1)} MB`:'size unavailable';return `Segment ${video.segmentIndex} · ${started} · ${duration} · ${size}`}
async function loadTripRecordings(value){const requestId=++recordingsRequest;const tripId=String(value||'').trim();const list=document.querySelector('#recordings-list'),status=document.querySelector('#recordings-status');list.replaceChildren();stopRecordingPlayback();if(!/^[1-9][0-9]{0,18}$/.test(tripId)){status.textContent='Select a vehicle with a trip or enter a positive Trip ID.';return}status.textContent=`Loading trip ${tripId}…`;try{await requireRecordingLogin();const videos=await api(`/api/v1/trips/${encodeURIComponent(tripId)}/videos`,{},true);if(requestId!==recordingsRequest)return;if(!videos.length){status.textContent=`No finalized recording segments are available for trip ${tripId}.`;return}status.textContent=`${videos.length} finalized segment${videos.length===1?'':'s'} for trip ${tripId}.`;for(const video of videos){const row=document.createElement('li'),description=document.createElement('span'),button=document.createElement('button');description.textContent=formatRecording(video);button.type='button';button.textContent='Play';button.addEventListener('click',()=>playTripRecording(video));row.append(description,button);list.append(row)}}catch(ex){if(requestId!==recordingsRequest)return;status.textContent=ex.message}}
async function playTripRecording(video){const status=document.querySelector('#recordings-status'),player=document.querySelector('#recording-player');status.textContent=`Requesting playback for segment ${video.segmentIndex}…`;try{await requireRecordingLogin();const result=await api(`/api/v1/trip-videos/${encodeURIComponent(video.tripVideoId)}/playback-url`,{method:'POST'},true);player.src=result.url;document.querySelector('#recording-player-panel').hidden=false;player.load();status.textContent=`Playing segment ${result.segmentIndex}. The private playback URL expires at ${new Date(result.expiresAt).toLocaleTimeString()}.`;try{await player.play()}catch{status.textContent+=' Press Play in the video controls to start.'}}catch(ex){status.textContent=ex.message}}
document.querySelector('#recordings-form').addEventListener('submit',event=>{event.preventDefault();void loadTripRecordings(document.querySelector('#recording-trip-id').value)});
document.querySelector('#stop-recording').addEventListener('click',stopRecordingPlayback);
document.querySelector('#login').addEventListener('submit',async e=>{e.preventDefault();try{const f=new FormData(e.currentTarget),result=await api('/api/v1/auth/login',{method:'POST',body:JSON.stringify(Object.fromEntries(f))});token=result.accessToken;sessionStorage.setItem('itsToken',token);start()}catch(ex){error.textContent=ex.message}});
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
async function boot(){
  try{demoMode=true;await start();return}catch{demoMode=false}
  if(token){
    try{await start();return}catch{
      token=null;
      sessionStorage.removeItem('itsToken');
    }
  }
  if(await autoLogin())await start();
}
boot().catch(e=>error.textContent=e.message);
