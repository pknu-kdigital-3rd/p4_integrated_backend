// DOM/control regression checks; no browser, no production allocations.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
class Element {
  constructor(tag, text='') { this.tag=tag;this.textContent=text;this.children=[];this.listeners={};this.disabled=false;this.className=''; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children=children; }
  addEventListener(name, handler) { this.listeners[name]=handler; }
  showModal() { this.open=true; }
}
test('real-status rendering, manual confirmation, selected-only release and refresh toggle', async () => {
  const elements={},all=[],requests=[];let timer;
  const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
  for(const [,id] of html.matchAll(/id="([^"]+)"/g)) elements[id]=new Element('div');
  const allocation={id:'000000000000000001',username:'<script>alert(1)</script>',client:'10.0.0.2:40000',relays:['10.0.0.1:39006'],clientProtocol:'UDP',relayProtocol:'UDP'};
  const status={sessions:[allocation],relay:{peer:{connectionState:'connected',iceConnectionState:'connected',iceGatheringState:'complete',signalingState:'stable'}},errors:[]};
  const document={hidden:false,getElementById:id=>elements[id],createElement:tag=>{const el=new Element(tag);all.push(el);return el;},querySelectorAll:()=>all.filter(el=>el.tag==='button'&&el.className==='danger')};
  const context=vm.createContext({document,Date,JSON,setInterval:handler=>{timer=handler;},fetch:async(url,options)=>{requests.push({url,options});return {ok:true,status:200,json:async()=>url==='/api/status'?status:{released:true}};}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'app.js'),'utf8'),context);
  await new Promise(resolve=>setImmediate(resolve));
  const row=elements.sessions.children[0],release=row.children.at(-1).children[0];
  assert.equal(release.disabled,false,'rendered release button must be usable after refresh');
  assert.equal(row.children[0].children[0].textContent,allocation.username,'usernames must be text, not HTML');
  const before=requests.length;timer();assert.equal(requests.length,before,'no background refresh by default');
  elements.auto.checked=true;document.hidden=true;timer();assert.equal(requests.length,before,'hidden page must not poll');
  document.hidden=false;timer();await new Promise(resolve=>setImmediate(resolve));assert.equal(requests.length,before+1);
  release.listeners.click();assert.equal(elements.confirmation.open,true);assert.equal(requests.filter(r=>r.url==='/api/release').length,0);
  elements.confirmation.returnValue='cancel';await elements.confirmation.listeners.close();assert.equal(requests.filter(r=>r.url==='/api/release').length,0);
  release.listeners.click();elements.confirmation.returnValue='release';await elements.confirmation.listeners.close();
  const posted=requests.find(r=>r.url==='/api/release');
  assert.deepEqual(JSON.parse(posted.options.body),{sessionId:allocation.id});
  assert.equal(posted.options.headers['X-Turn-Control'],'release');
  assert.equal(elements.refresh.disabled,false);
  assert.equal(elements.sessions.children[0].children.at(-1).children[0].disabled,false);
});
