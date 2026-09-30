const rad=Math.PI/180;
const earth=6371000;
function metres(a,b){
  const dLat=(b[1]-a[1])*rad,dLon=(b[0]-a[0])*rad;
  const x=Math.sin(dLat/2)**2+Math.cos(a[1]*rad)*Math.cos(b[1]*rad)*Math.sin(dLon/2)**2;
  return 2*earth*Math.asin(Math.min(1,Math.sqrt(x)));
}

export function plannedProgress(geometry,fix){
  const coordinates=geometry?.coordinates;
  if(!Array.isArray(coordinates)||coordinates.length<2||!Number.isFinite(fix?.latitude)||!Number.isFinite(fix?.longitude))return null;
  const at=[fix.longitude,fix.latitude],latScale=111195,lonScale=latScale*Math.cos(fix.latitude*rad);
  let covered=0,total=0,closest=Infinity,position=0;
  for(let i=1;i<coordinates.length;i++){
    const a=coordinates[i-1],b=coordinates[i],length=metres(a,b);
    if(!Number.isFinite(length)||length===0)continue;
    const dx=(b[0]-a[0])*lonScale,dy=(b[1]-a[1])*latScale;
    const fraction=Math.max(0,Math.min(1,(((at[0]-a[0])*lonScale)*dx+((at[1]-a[1])*latScale)*dy)/(dx*dx+dy*dy)));
    const distance=Math.hypot((at[0]-a[0])*lonScale-fraction*dx,(at[1]-a[1])*latScale-fraction*dy);
    if(distance<closest){closest=distance;position=covered+fraction*length}
    covered+=length;total+=length;
  }
  if(!total)return null;
  return {percent:Math.round(100*position/total),remainingM:Math.round(total-position),offRouteM:Math.round(closest)};
}

/** Keep only the route ahead of the current fix, including the fix itself. */
export function remainingRoute(coordinates,fix,minPosition=0){
  if(!Array.isArray(coordinates)||coordinates.length<2||!Number.isFinite(fix?.latitude)||!Number.isFinite(fix?.longitude))return null;
  const at=[fix.longitude,fix.latitude],latScale=111195,lonScale=latScale*Math.cos(fix.latitude*rad);
  let closest=Infinity,position=0;
  for(let i=Math.max(1,Math.floor(minPosition));i<coordinates.length;i++){
    const a=coordinates[i-1],b=coordinates[i];
    if(!Array.isArray(a)||!Array.isArray(b)||!a.concat(b).every(Number.isFinite))continue;
    const dx=(b[0]-a[0])*lonScale,dy=(b[1]-a[1])*latScale,denominator=dx*dx+dy*dy;
    if(!denominator)continue;
    const fraction=Math.max(0,Math.min(1,(((at[0]-a[0])*lonScale)*dx+((at[1]-a[1])*latScale)*dy)/denominator));
    const distance=Math.hypot((at[0]-a[0])*lonScale-fraction*dx,(at[1]-a[1])*latScale-fraction*dy);
    const candidate=i-1+fraction;
    if(candidate>=minPosition-0.01&&distance<closest){closest=distance;position=candidate}
  }
  position=Math.max(minPosition,position);
  const segment=Math.min(coordinates.length-2,Math.floor(position));
  const fraction=position-segment,a=coordinates[segment],b=coordinates[segment+1];
  const join=[a[0]+(b[0]-a[0])*fraction,a[1]+(b[1]-a[1])*fraction];
  const ahead=[at,join,...coordinates.slice(segment+1)];
  return {position,latLngs:ahead.map(([lon,lat])=>[lat,lon])};
}

/** Fractional segment index at the current recorded playback timestamp. */
export function recordedRoutePosition(points,sourceTimestampNs){
  if(!Array.isArray(points)||points.length<2||sourceTimestampNs==null)return null;
  const time=BigInt(sourceTimestampNs);
  if(time<=BigInt(points[0][0]))return 0;
  if(time>=BigInt(points.at(-1)[0]))return points.length-1;
  let low=0,high=points.length-1;
  while(high-low>1){const mid=(low+high)>>1;if(BigInt(points[mid][0])<=time)low=mid;else high=mid}
  const start=BigInt(points[low][0]),span=BigInt(points[high][0])-start;
  return low+(span?Number(time-start)/Number(span):0);
}

export function recordedProgress(preview,sourceTimestampNs){
  const points=preview?.points;
  if(!Array.isArray(points)||points.length<2||sourceTimestampNs==null)return null;
  const time=BigInt(sourceTimestampNs);
  const first=BigInt(points[0][0]),last=BigInt(points.at(-1)[0]);
  if(time<first)return {percent:0,remainingM:preview.totalDistanceM};
  if(time>=last)return {percent:100,remainingM:0};
  let low=0,high=points.length-1;
  while(high-low>1){const mid=(low+high)>>1;if(BigInt(points[mid][0])<=time)low=mid;else high=mid}
  const a=points[low],b=points[high],fraction=Number(time-BigInt(a[0]))/Number(BigInt(b[0])-BigInt(a[0]));
  const travelled=a[3]+fraction*(b[3]-a[3]),total=preview.totalDistanceM;
  return {percent:total?Math.round(100*travelled/total):100,remainingM:Math.round(total-travelled)};
}

/** "14:10" in the operator's local time (or `timeZone` when given). */
export function formatClock(value,timeZone){
  const date=value instanceof Date?value:new Date(value??'');
  if(Number.isNaN(date.getTime()))return null;
  return new Intl.DateTimeFormat('ko-KR',{hour:'2-digit',minute:'2-digit',hour12:false,timeZone}).format(date);
}

// Expected travel time: the planned route's duration, or for a replay-only
// trip the span of the recorded GPS path.
function tripDurationMs(display){
  const seconds=Number(display?.plannedRoute?.durationSec);
  if(Number.isFinite(seconds)&&seconds>0)return seconds*1000;
  const points=display?.replayPreview?.points;
  if(Array.isArray(points)&&points.length>1){
    const spanNs=BigInt(points.at(-1)[0])-BigInt(points[0][0]);
    if(spanNs>0n)return Number(spanNs/1_000_000n);
  }
  return null;
}

/** Departure and arrival captions for the trip progress track. */
export function tripTimes(display,timeZone){
  const started=formatClock(display?.startedAt,timeZone),planned=formatClock(display?.plannedStartAt,timeZone);
  const origin=started?`${started} 출발`:planned?`${planned} 출발 예정`:'출발 대기';
  if(display?.tripStatus==='CANCELLED')return {origin,destination:'운행 취소'};
  const ended=formatClock(display?.endedAt,timeZone);
  if(display?.tripStatus==='COMPLETED'&&ended)return {origin,destination:`${ended} 도착`};
  const departure=display?.startedAt??display?.plannedStartAt,duration=tripDurationMs(display);
  const eta=departure&&duration?formatClock(new Date(new Date(departure).getTime()+duration),timeZone):null;
  return {origin,destination:eta?`${eta} 도착 예정`:'도착 시간 미정'};
}

/**
 * Progress of an Android replay position along the operator's planned route,
 * so the percentage matches the route's destination and arrival time. The
 * replay path may differ from that route, so a far position still gets a
 * percentage (its nearest route point) plus how far off the route it is.
 * Labelled as replay: it is never real trip progress.
 */
export function replayProgressOnRoute(geometry,fix,offRouteNoticeM=100){
  const progress=plannedProgress(geometry,fix);
  if(!progress)return null;
  const off=progress.offRouteM>offRouteNoticeM?` · 계획 경로에서 ${progress.offRouteM} m 떨어짐`:'';
  return {...progress,label:`GPS 재생 위치 기준 ${progress.percent}% · 남은 계획 경로 ${(progress.remainingM/1000).toFixed(1)} km${off}`};
}
