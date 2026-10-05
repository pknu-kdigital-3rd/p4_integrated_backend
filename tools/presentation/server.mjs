#!/usr/bin/env node
// A separate, dependency-free presentation host. Never imports production services.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, '../../operator-web');
const port = Number(process.env.DEMO_PORT || 3080);
const positions = [[35.1796,129.0756],[35.164,129.064],[35.157,129.059],[35.191,129.089],
  [35.177,129.106],[35.154,129.119],[35.187,129.057],[35.168,129.085]];
const statuses = ['DRIVING','DRIVING','READY','DRIVING','MAINTENANCE','DRIVING','OFFLINE','READY'];
const fleet = () => positions.map(([latitude,longitude], i) => ({
  vehicleId: String(i+1), vehicleCode: `DEMO-${String(i+1).padStart(2,'0')}`,
  vehicleName: i === 0 ? '발표용 영상 차량' : `부산 데모 차량 ${i+1}`,
  vehicleSource: i === 0 ? 'CUSTOM' : 'BIMS', vehicleStatus: statuses[i], isActive: true,
  telemetry: { external_id: `demo:${i+1}`, latitude, longitude,
    speed_kmh: statuses[i] === 'DRIVING' ? 28+i*3 : 0, heading_deg: 45+i*25,
    telemetry_source: i === 0 ? 'DEVICE_GPS' : 'BIMS_REPLAY',
    observed_at_utc: new Date().toISOString(), route_progress_pct: null,
    source_metadata: i === 0 ? {vehicleId:'1',recordingSessionId:'presentation-session',state:'live'} : {state:'playback'},
  },
}));
let telemetryMode = {mode:'playback',available:true,historyCompensationEnabled:false};
const scenario = {scenarioId:'1',name:'부산 발표 시나리오 (UI 미리보기)',restrictionRevision:0,restrictions:[]};

function json(res, data, status=200) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'});
  res.end(JSON.stringify(status === 200 ? {data} : {error:{message:data}}));
}
async function api(req,res,url) {
  const route = url.pathname.replace('/api/v1/demo/','/api/v1/');
  if (route === '/api/v1/auth/me') return json(res,{role:'OPERATOR',loginId:'presentation'});
  if (route === '/api/v1/bootstrap') return json(res,{
    services:{vision:{baseUrl:`http://127.0.0.1:${port}/demo/vision`},routingTracking:{baseUrl:`http://127.0.0.1:${port}`}},
    liveViewUrl:`http://127.0.0.1:${port}/demo/vision`,
  });
  if (route === '/api/v1/tracking/vehicles') return json(res,{generated_at_utc:new Date().toISOString(),vehicles:fleet(),warnings:[]});
  if (route === '/api/v1/tracking/telemetry-mode') {
    if (req.method === 'PUT') {
      let body=''; for await (const chunk of req) { body+=chunk; if(body.length>4096) return json(res,'Request too large',413); }
      const settings=JSON.parse(body);
      telemetryMode={...telemetryMode,mode:settings.mode === 'live' ? 'live' : 'playback',historyCompensationEnabled:settings.historyCompensationEnabled === true};
    }
    return json(res,telemetryMode);
  }
  if (req.method !== 'GET') return json(res,'발표 모드: 이 작업에는 실제 백엔드가 필요합니다. 데이터는 저장되지 않습니다.',501);
  if (route === '/api/v1/vehicles') return json(res,fleet());
  if (route === '/api/v1/trips') return json(res,[]);
  if (/\/replay-preview$/.test(route)) return json(res,{available:false,reason:'발표 모드에는 실제 GPS 녹화가 없습니다.'});
  if (route === '/api/v1/virtual/scenarios') return json(res,[scenario]);
  if (route === '/api/v1/virtual/scenarios/1') return json(res,scenario);
  if (route === '/api/v1/virtual/scenarios/1/vehicles') return json(res,fleet().slice(0,3).map(v=>({
    ...v,vehicleSource:'VIRTUAL',state:{simStatus:'READY',speedKmh:0,lastPosition:{lat:v.telemetry.latitude,lon:v.telemetry.longitude}},
    following:{autoFollowEnabled:true,policyVersion:1},
  })));
  if (/\/virtual\/scenarios\/1\/(events|dispatch-requests)$/.test(route)) return json(res,[]);
  return json(res,'발표 모드에서 지원하지 않는 API입니다.',404);
}

const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
const server=http.createServer(async(req,res)=>{
  // Runtime traffic is restricted to this host, including map, scripts and frames.
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self' about:; media-src 'self' blob:; object-src 'none'");
  res.setHeader('Cache-Control','no-store');
  try {
    const url=new URL(req.url,'http://localhost');
    if(url.pathname.startsWith('/api/')) return await api(req,res,url);
    if(url.pathname === '/') {res.writeHead(302,{Location:'/operator/'});return res.end();}
    let root=web, relative=url.pathname.replace(/^\/operator\//,'');
    if(url.pathname.startsWith('/demo/')) {root=here;relative=url.pathname.slice(6);}
    if(relative === 'vision') relative='vision.html';
    if(!relative) relative='index.html';
    const filename=path.resolve(root,relative);
    if(!filename.startsWith(root+path.sep)) return json(res,'Not found',404);
    let body=await readFile(filename);
    if(filename === path.join(web,'index.html')) {
      body=body.toString().replace(/<link href="https:[^"]+" rel="stylesheet"\/>/g,'')
        .replace(/<script src="https:[^"]+">\s*<\/script>/g,'')
        .replace('</head>','<link rel="stylesheet" href="/demo/vendor/leaflet.css"/><link rel="stylesheet" href="/demo/demo.css"/></head>')
        .replace('<body>','<body><div class="presentation-banner">발표 모드 · 샘플 데이터 / 모의 영상 탐지 / 스크립트 AI · 외부 API 사용 없음</div>')
        .replace('<script src="app.js','<script src="/demo/vendor/leaflet.js"></script><script src="/demo/setup.js"></script><script src="app.js');
    }
    if(filename === path.join(web,'app.js')) {
      body=body.toString().replace("L.tileLayer('/osm/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap contributors'})",
        "L.imageOverlay('/demo/map.svg',[[35.12,129.02],[35.22,129.14]],{attribution:'발표용 도식 지도 · 실제 도로 지도 아님'})");
    }
    if(filename === path.join(web,'assistant-panel.js')) {
      const source=body.toString();
      const start=source.indexOf('function createAssistantConnection(');
      const end=source.indexOf('export const AUTO_TARGET',start);
      if(start<0 || end<0) throw new Error('Assistant module changed: update presentation adapter');
      body="import {createDemoAssistantConnection} from '/demo/assistant.js';\n"+source.slice(0,start)+
        'const createAssistantConnection = createDemoAssistantConnection;\n\n'+source.slice(end);
    }
    res.writeHead(200,{'Content-Type':`${mime[path.extname(filename)] || 'text/plain'}; charset=utf-8`});
    res.end(body);
  } catch(error) {
    json(res,error.code === 'ENOENT' ? 'Not found' : error.message,error.code === 'ENOENT' ? 404 : 500);
  }
});
server.listen(port,'127.0.0.1',()=>console.log(`Presentation UI: http://127.0.0.1:${port}/operator/\nSample data only. No GPUs, database, Docker or external APIs. Ctrl+C to stop.`));
server.on('error',error=>{console.error(error.message);process.exitCode=1;});
