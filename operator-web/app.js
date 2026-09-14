const map=L.map('map').setView([35.1796,129.0756],12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap'}).addTo(map);
const markers=new Map();let token=sessionStorage.getItem('itsToken');let bootstrap;let selected;let routeLayer;let demoMode=false;
const error=document.querySelector('#error'),details=document.querySelector('#details'),fields=document.querySelector('#fields');
async function api(path,options={},raw=false){const requestPath=demoMode&&!raw?path.replace('/api/v1/','/api/v1/demo/'):path;const response=await fetch(requestPath,{...options,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})}});if(!response.ok)throw new Error((await response.json().catch(()=>({}))).error?.message||`HTTP ${response.status}`);return (await response.json()).data}
function selectVehicle(item){selected=item;details.hidden=false;const t=item.telemetry,r=item.plannedRoute;fields.innerHTML=`<dt>Vehicle</dt><dd>${item.vehicleName||item.vehicleCode||t.external_id}</dd><dt>Source</dt><dd>${item.vehicleSource||'BIMS'} / ${t.telemetry_source}</dd><dt>Status</dt><dd>${item.vehicleStatus||t.source_metadata?.state||'ACTIVE'}</dd><dt>Speed</dt><dd>${t.speed_kmh??'—'} km/h</dd><dt>Observed</dt><dd>${t.observed_at_utc||'—'}</dd>`;document.querySelector('#route-label').textContent=`Planned Route: ${r?.routeSource||'unavailable'}`;if(routeLayer){map.removeLayer(routeLayer);routeLayer=null}if(r?.routeGeojson){routeLayer=L.geoJSON(r.routeGeojson,{style:{color:'#ffb703',weight:5}}).addTo(map)}}
function render(snapshot){for(const item of snapshot.vehicles){const t=item.telemetry,key=t.external_id,pos=[t.latitude,t.longitude];let marker=markers.get(key);if(!marker){marker=L.circleMarker(pos,{radius:8,color:'#fff',fillColor:'#16c79a',fillOpacity:.9}).addTo(map).on('click',()=>selectVehicle(item));markers.set(key,marker)}else marker.setLatLng(pos);marker.bindTooltip(item.vehicleCode||key)}}
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
document.querySelector('#login').addEventListener('submit',async e=>{e.preventDefault();try{const f=new FormData(e.currentTarget),result=await api('/api/v1/auth/login',{method:'POST',body:JSON.stringify(Object.fromEntries(f))});token=result.accessToken;sessionStorage.setItem('itsToken',token);start()}catch(ex){error.textContent=ex.message}});
function browserReachableUrl(configuredUrl){
  const url=new URL(configuredUrl,window.location.href);
  if(url.hostname==='127.0.0.1'||url.hostname==='localhost')url.hostname=window.location.hostname;
  return url.href;
}
document.querySelector('#live-view').addEventListener('click',()=>{
  if(!bootstrap)return;
  document.querySelector('#live-view-frame').src=browserReachableUrl(bootstrap.liveViewUrl);
  document.querySelector('#live-view-panel').hidden=false;
});
document.querySelector('#close-live-view').addEventListener('click',()=>{
  document.querySelector('#live-view-panel').hidden=true;
  document.querySelector('#live-view-frame').src='about:blank';
});
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
