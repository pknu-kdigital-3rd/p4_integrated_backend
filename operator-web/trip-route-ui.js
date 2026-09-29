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
