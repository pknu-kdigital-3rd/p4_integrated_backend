import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source=readFileSync(new URL('../../operator-web/app.js',import.meta.url),'utf8');
const start=source.indexOf('async function loadTripRecordings(');
const loader=source.slice(start,source.indexOf('\nfunction drawReplayOverlay',start));
function deferred() {
  let resolve!: (value?: any)=>void;
  const promise=new Promise<any>(done=>{resolve=done;});
  return {promise,resolve};
}
function setup(initiallyHidden=false) {
  const elements=new Map<string,any>();
  const element=(id: string)=>{
    if(!elements.has(id))elements.set(id,{
      hidden:true,inert:false,attributes:{},textContent:'',value:'',
      setAttribute(name: string,value: string){this.attributes[name]=value;},replaceChildren:vi.fn(),
    });
    return elements.get(id);
  };
  const panel=element('#recording-player-panel');panel.hidden=initiallyHidden;
  const context: any={
    document:{querySelector:element},recordingsRequest:0,replayTripId:'old',
    tripRecordingVideos:[],replayTimeline:[],replayDuration:0,replayIndex:0,
    clearRecordingDeleteSelection:vi.fn(),closeRecordingDeleteMode:vi.fn(),
    updateRecordingDeleteTools:vi.fn(),renderReplayBreakMarkers:vi.fn(),
    requireRecordingLogin:vi.fn(async()=>{}),
    api:vi.fn(async()=>[{tripVideoId:'1'}]),
    buildReplayTimeline:()=>({entries:[{start:0,duration:10}],duration:10}),
    formatReplayTime:()=> '0:10',drawReplayOverlay:vi.fn(),openRecordingDeleteMode:vi.fn(),
  };
  context.stopRecordingPlayback=vi.fn(()=>{
    expect(panel.attributes['aria-busy']).toBe('true');
    expect(panel.inert).toBe(true);
    context.replayIndex=-1;
  });
  context.seekReplay=vi.fn(async()=>{context.replayIndex=0;});
  runInNewContext(loader,context);
  return {context,panel,element};
}

describe('recording player vehicle switches',()=>{
  it('masks the previous video before teardown and keeps the layout until the new video is ready',async()=>{
    const {context,panel}=setup();
    const ready=deferred();
    context.seekReplay.mockImplementation(async()=>{await ready.promise;context.replayIndex=0;});
    const loading=context.loadTripRecordings('21');
    await vi.waitFor(()=>expect(context.seekReplay).toHaveBeenCalled());
    expect(panel.hidden).toBe(false);
    expect(panel.attributes['aria-busy']).toBe('true');
    expect(panel.inert).toBe(true);
    ready.resolve();await loading;
    expect(panel.hidden).toBe(false);
    expect(panel.attributes['aria-busy']).toBe('false');
    expect(panel.inert).toBe(false);
    expect(context.drawReplayOverlay).toHaveBeenCalledOnce();
  });

  it('does not reveal a first-time player before segment activation completes',async()=>{
    const {context,panel}=setup(true);
    const ready=deferred();
    context.seekReplay.mockImplementation(async()=>{await ready.promise;context.replayIndex=0;});
    const loading=context.loadTripRecordings('21');
    await vi.waitFor(()=>expect(context.seekReplay).toHaveBeenCalled());
    expect(panel.hidden).toBe(true);
    ready.resolve();await loading;
    expect(panel.hidden).toBe(false);
  });

  it('does not reveal an obsolete request after selecting a vehicle without a trip',async()=>{
    const {context,panel}=setup();
    const ready=deferred();
    context.seekReplay.mockImplementation(async()=>{await ready.promise;context.replayIndex=0;});
    const loading=context.loadTripRecordings('21');
    await vi.waitFor(()=>expect(context.seekReplay).toHaveBeenCalled());
    await context.loadTripRecordings('');
    expect(panel.hidden).toBe(true);
    ready.resolve();await loading;
    expect(panel.hidden).toBe(true);
    expect(panel.attributes['aria-busy']).toBe('false');
    expect(context.drawReplayOverlay).not.toHaveBeenCalled();
  });

  it('leaves loading state owned by the newer request when the older fetch finishes',async()=>{
    const {context,panel}=setup();
    const first=deferred(),second=deferred();
    context.api.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const old=context.loadTripRecordings('21');
    await vi.waitFor(()=>expect(context.api).toHaveBeenCalledTimes(1));
    const current=context.loadTripRecordings('22');
    await vi.waitFor(()=>expect(context.api).toHaveBeenCalledTimes(2));
    first.resolve([{tripVideoId:'old'}]);await old;
    expect(panel.attributes['aria-busy']).toBe('true');
    expect(panel.inert).toBe(true);
    expect(context.seekReplay).not.toHaveBeenCalled();
    second.resolve([{tripVideoId:'new'}]);await current;
    expect(panel.attributes['aria-busy']).toBe('false');
    expect(context.replayTripId).toBe('22');
  });

  it('hides the player and clears the mask for missing or failed recordings',async()=>{
    for(const fail of [false,true]){
      const {context,panel}=setup();
      if(fail)context.api.mockRejectedValue(new Error('Unavailable'));
      else context.api.mockResolvedValue([]);
      await context.loadTripRecordings('21');
      expect(panel.hidden).toBe(true);
      expect(panel.inert).toBe(false);
      expect(panel.attributes['aria-busy']).toBe('false');
    }
  });

  it('restores deletion controls after the player is ready and interactive',async()=>{
    const {context,panel,element}=setup();
    element('#recording-delete-mode').hidden=false;
    context.openRecordingDeleteMode.mockImplementation(()=>expect(panel.inert).toBe(false));
    await context.loadTripRecordings('21',true);
    expect(context.openRecordingDeleteMode).toHaveBeenCalledOnce();
  });
});
