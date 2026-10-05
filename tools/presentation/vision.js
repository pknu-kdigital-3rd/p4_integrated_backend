const canvas=document.querySelector('#scene'),ctx=canvas.getContext('2d');
let paused=false,boxes=true,distance=false,time=0,last=performance.now(),seq=0;
const send=data=>parent.postMessage(data,location.origin);
function polygon(points,color){ctx.fillStyle=color;ctx.beginPath();points.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.closePath();ctx.fill();}
function object(x,y,w,h,label,color){
  ctx.fillStyle='#364c64';ctx.fillRect(x,y,w,h);ctx.fillStyle='#93bfda';ctx.fillRect(x+6,y+6,w-12,h*.32);
  ctx.fillStyle='#142334';ctx.fillRect(x+5,y+h-5,12,12);ctx.fillRect(x+w-17,y+h-5,12,12);
  if(!boxes)return;
  ctx.strokeStyle=distance?'#ffb454':color;ctx.lineWidth=3;ctx.strokeRect(x-8,y-8,w+16,h+22);
  ctx.fillStyle=ctx.strokeStyle;ctx.fillRect(x-8,y-34,w+75,26);ctx.fillStyle='#0a1726';ctx.font='18px sans-serif';ctx.fillText(label,x-3,y-15);
}
function draw(now){
  if(!paused)time+=(now-last)/1000;last=now;
  const sky=ctx.createLinearGradient(0,0,0,350);sky.addColorStop(0,'#7db4d2');sky.addColorStop(1,'#d8e7ee');ctx.fillStyle=sky;ctx.fillRect(0,0,1280,720);
  for(let i=0;i<11;i++){const x=i*120,h=90+(i%4)*35;ctx.fillStyle=i%2?'#bbc4cc':'#ccd3d6';ctx.fillRect(x,330-h,100,h);ctx.fillStyle='#7c9cab';for(let y=345-h;y<315;y+=24)for(let xx=x+12;xx<x+90;xx+=24)ctx.fillRect(xx,y,11,12);}
  polygon([[0,330],[1280,330],[1280,720],[0,720]],'#94a798');
  polygon([[475,330],[795,330],[1240,720],[40,720]],'#4e5863');
  polygon([[475,330],[440,330],[0,720],[40,720]],'#d1d1c4');polygon([[795,330],[830,330],[1280,720],[1240,720]],'#d1d1c4');
  for(let i=0;i<8;i++){const t=((i/8+time*.12)%1),y=330+390*t*t,w=2+8*t;ctx.fillStyle='#f0ead0';ctx.fillRect(640-w/2,y,w,8+48*t);}
  const sway=Math.sin(time*.6)*18;
  object(715+sway,420,110,90,'car · 18.4 m','#6ef0a7');object(420-sway,365,72,65,'car · 32.1 m','#6ef0a7');
  ctx.fillStyle='#efb16f';ctx.beginPath();ctx.arc(970,472,12,0,Math.PI*2);ctx.fill();ctx.fillStyle='#346c97';ctx.fillRect(959,488,23,45);ctx.fillStyle='#233747';ctx.fillRect(958,533,8,30);ctx.fillRect(975,533,8,30);
  if(boxes){ctx.strokeStyle=distance?'#ff6565':'#7cd6ff';ctx.strokeRect(947,450,48,119);ctx.fillStyle=ctx.strokeStyle;ctx.font='18px sans-serif';ctx.fillText('person · 9.8 m',930,440);}
  ctx.fillStyle='#101b2a';polygon([[0,690],[360,655],[900,655],[1280,690],[1280,720],[0,720]],'#152230');
  requestAnimationFrame(draw);
}
document.querySelector('#pause').onclick=event=>{paused=!paused;event.target.textContent=paused?'재생':'일시 정지';};
document.querySelector('#boxes').onclick=event=>{boxes=!boxes;event.target.textContent=boxes?'탐지 표시 끄기':'탐지 표시 켜기';};
window.addEventListener('message',event=>{
  if(event.origin!==location.origin || event.source!==parent)return;
  if(event.data?.type==='operator-live-view-distance-coloring'){distance=event.data.enabled===true;send({type:'live-view-distance-coloring',enabled:distance});}
});
setInterval(()=>{
  send({type:'live-view-playback-state',loading:false});
  send({type:'live-view-video-size',width:1280,height:720});
  send({type:'live-view-distance-coloring',enabled:distance});
  send({type:'live-vehicle-telemetry',epoch:1,seq:++seq,recording:{vehicleId:'1',recordingSessionId:'presentation-session'},
    telemetry:{status:'ok',gps:{latitude:35.1796,longitude:129.0756,speed_kmh:28,bearing_deg:45}},detections:{car:2,person:1}});
},500);
requestAnimationFrame(draw);
