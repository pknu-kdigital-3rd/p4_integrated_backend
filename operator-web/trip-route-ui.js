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
// A snapped position may only search this far ahead of the previous one, and
// not onto segments facing more than this away from the vehicle's heading, so
// an intersection, a parallel road or a route that doubles back cannot pull
// the marker far ahead.
export const SNAP_SEARCH_AHEAD_M=300;
const SNAP_MAX_HEADING_DIFF_DEG=100;

export function remainingRoute(coordinates,fix,minPosition=0,snapStart=false,fixedPosition=false,{maxAheadM=Infinity,headingDeg=null}={}){
  if(!Array.isArray(coordinates)||coordinates.length<2||!Number.isFinite(fix?.latitude)||!Number.isFinite(fix?.longitude))return null;
  const at=[fix.longitude,fix.latitude],latScale=111195,lonScale=latScale*Math.cos(fix.latitude*rad);
  let closest=Infinity,position=0,travelled=0;
  for(let i=Math.max(1,Math.floor(minPosition));!fixedPosition&&i<coordinates.length;i++){
    if(travelled>maxAheadM)break;
    const a=coordinates[i-1],b=coordinates[i];
    if(!Array.isArray(a)||!Array.isArray(b)||!a.concat(b).every(Number.isFinite))continue;
    const dx=(b[0]-a[0])*lonScale,dy=(b[1]-a[1])*latScale,denominator=dx*dx+dy*dy;
    if(!denominator)continue;
    const lengthM=Math.sqrt(denominator);
    // Only the part of the first segment beyond minPosition counts as travel.
    travelled+=lengthM*(i-1<minPosition?Math.max(0,1-(minPosition-(i-1))):1);
    if(Number.isFinite(headingDeg)){
      const bearing=(Math.atan2(dx,dy)*180/Math.PI+360)%360,diff=Math.abs(((bearing-headingDeg)%360+540)%360-180);
      if(diff>SNAP_MAX_HEADING_DIFF_DEG)continue;
    }
    const fraction=Math.max(0,Math.min(1,(((at[0]-a[0])*lonScale)*dx+((at[1]-a[1])*latScale)*dy)/denominator));
    const distance=Math.hypot((at[0]-a[0])*lonScale-fraction*dx,(at[1]-a[1])*latScale-fraction*dy);
    const candidate=i-1+fraction;
    if(candidate>=minPosition-0.01&&distance<closest){closest=distance;position=candidate}
  }
  position=Math.max(minPosition,position);
  const segment=Math.min(coordinates.length-2,Math.floor(position));
  const fraction=position-segment,a=coordinates[segment],b=coordinates[segment+1];
  const join=[a[0]+(b[0]-a[0])*fraction,a[1]+(b[1]-a[1])*fraction];
  const ahead=snapStart?[join,...coordinates.slice(segment+1)]:[at,join,...coordinates.slice(segment+1)];
  return {position,latLngs:ahead.map(([lon,lat])=>[lat,lon])};
}

/** Locate a replay timestamp along the road geometry's timed anchors. */
export function matchedRoutePosition(anchors,sourceTimestampNs,coordinateDistancesM){
  if(!Array.isArray(anchors)||anchors.length<2||sourceTimestampNs==null)return null;
  const time=BigInt(sourceTimestampNs);
  if(time<=BigInt(anchors[0].sourceTimestampNs))return anchors[0].routePosition;
  if(time>=BigInt(anchors.at(-1).sourceTimestampNs))return anchors.at(-1).routePosition;
  let low=0,high=anchors.length-1;
  while(high-low>1){const mid=(low+high)>>1;if(BigInt(anchors[mid].sourceTimestampNs)<=time)low=mid;else high=mid}
  const start=BigInt(anchors[low].sourceTimestampNs),span=BigInt(anchors[high].sourceTimestampNs)-start;
  const fraction=span?Number(time-start)/Number(span):0;
  if(!Array.isArray(coordinateDistancesM)||!Number.isFinite(anchors[low].routeDistanceM))
    return anchors[low].routePosition+fraction*(anchors[high].routePosition-anchors[low].routePosition);
  const distance=anchors[low].routeDistanceM+fraction*(anchors[high].routeDistanceM-anchors[low].routeDistanceM);
  let first=0,last=coordinateDistancesM.length-1;
  while(last-first>1){const middle=(first+last)>>1;if(coordinateDistancesM[middle]<=distance)first=middle;else last=middle}
  const segmentM=coordinateDistancesM[last]-coordinateDistancesM[first];
  return first+(segmentM?Math.max(0,Math.min(1,(distance-coordinateDistancesM[first])/segmentM)):0);
}

/** Advance a replay fix briefly during a GPS gap; never beyond 45 seconds. */
// Predicts from the moment the fix was received, continuously: waiting for a
// gap to build up first and then adding all of it at once reads as a jump.
export function estimatedReplayTimestamp(sourceTimestampNs,receivedAt,nowMs,speedKmh){
  if(sourceTimestampNs==null||!Number.isFinite(speedKmh)||speedKmh<=3)return null;
  const age=nowMs-new Date(receivedAt??'').getTime();
  if(!Number.isFinite(age)||age<0)return null;
  const elapsedMs=Math.min(age,45000);
  return (BigInt(sourceTimestampNs)+BigInt(Math.round(elapsedMs*1e6))).toString();
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

function distanceAtPosition(distances,position){
  const first=Math.max(0,Math.min(distances.length-1,Math.floor(position))),next=Math.min(distances.length-1,first+1);
  return distances[first]+(position-first)*(distances[next]-distances[first]);
}

/**
 * Keeps a displayed route position from stepping back for a small correction
 * (a fresh fix landing just behind a prediction), which reads as a jump back.
 * A larger step back is a real seek in the recording and is followed.
 */
export function forwardOnlyPosition(previous,next,distances,toleranceM=80){
  if(!Number.isFinite(next))return previous;
  if(!Number.isFinite(previous)||next>=previous)return next;
  if(!Array.isArray(distances)||distances.length<2)return previous;
  return distanceAtPosition(distances,previous)-distanceAtPosition(distances,next)<=toleranceM?previous:next;
}

/**
 * Timestamp anchors for a replay line: the road match's own, or - without a
 * match - every recorded GPS point, so the replay marker's place on the line is
 * always set by the recording's time rather than by a nearest-segment search.
 */
export function replayLineTiming(preview){
  if(preview?.roadMatch?.anchors?.length>1)return {anchors:preview.roadMatch.anchors,distances:preview.roadMatch.coordinateDistancesM};
  const points=preview?.points;
  if(!Array.isArray(points)||points.length<2)return null;
  return {anchors:points.map((point,index)=>({sourceTimestampNs:point[0],routePosition:index,routeDistanceM:point[3]})),
    distances:points.map(point=>point[3])};
}

/**
 * The replay's current clock, published by the relay from the phone's latest
 * telemetry batch: {time, at}, or null when absent or not newer than the last
 * GPS fix (the fix then says the same, and more precisely).
 */
export function replayClock(metadata){
  const time=metadata?.sourceClockNs,at=metadata?.sourceClockAt;
  if(typeof time!=='string'||!/^\d+$/.test(time)||!at)return null;
  const fix=metadata?.sourceTimestampNs;
  if(typeof fix==='string'&&/^\d+$/.test(fix)&&BigInt(time)<=BigInt(fix))return null;
  return {time,at};
}
