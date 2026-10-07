import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { createServerPlaybackView } from '../operator-web/live-telemetry.js';

const source=readFileSync(new URL('../../operator-web/app.js',import.meta.url),'utf8');
function appFunction(name: string) {
  const start=source.indexOf(`function ${name}(`);
  const end=source.indexOf('\n}',start)+2;
  if(start<0||end<=start)throw new Error(`Missing app function: ${name}`);
  return source.slice(start,end);
}

function setup(tab='saved',previousPreview=false) {
  const elements=new Map<string,any>();
  function element(id: string) {
    if(!elements.has(id))elements.set(id,{
      hidden:false,options:[],value:'',textContent:'',
      attributes:{},getAttribute(name: string){return this.attributes[name];},
      focus:vi.fn(),replaceChildren:vi.fn(),append:vi.fn(),
    });
    return elements.get(id);
  }
  const livePanel=element('#live-view-panel');
  livePanel.hidden=!previousPreview;
  livePanel.contains=(target: unknown)=>target===livePanel;
  const document={
    activeElement:element('#recording-saved-tab'),fullscreenElement:null,
    querySelector:element,createElement:()=>({textContent:''}),
  };
  function chooseTab(name: string) {
    for(const key of ['live','saved']){
      element(`#recording-${key}-tab`).attributes['aria-pressed']=String(key===name);
      element(`#recording-${key}-content`).hidden=key!==name;
    }
  }
  chooseTab(tab);
  const navigations: Array<{url:string;hidden:boolean}>=[];
  const liveFrame={set src(url: string){navigations.push({url,hidden:livePanel.hidden});}};
  const streaming={vehicleId:'2',vehicleCode:'CUSTOM-TRUCK-02',telemetry:{external_id:'device:2',source_metadata:{vehicleId:'2',recordingSessionId:'session-2'}}};
  const context: any={
    document,livePanel,liveFrame,URL,window:{isSecureContext:true,__virtualMode:false},
    bootstrap:{liveViewUrl:'https://vision.example/live'},selected:{vehicleId:'1',telemetry:{external_id:'device:1'}},
    liveView:previousPreview?{vehicleId:'1',markerKey:'device:1'}:null,
    liveDocked:false,lastLiveMessage:null,liveVideoSize:null,liveDetections:null,liveStatusTimer:undefined,
    replayTripId:'',replayTimeline:[],replayIndex:0,
    markers:new Map(),details:element('#details'),fields:element('#fields'),
    operatorLayout:{classList:{remove:vi.fn(),toggle:vi.fn()}},
    liveMapFollower:{begin:vi.fn()},
    syncVehiclePickers:vi.fn(),loadAssignmentPreview:vi.fn(),syncLiveViewButton:vi.fn(),
    renderVehicleDetails:vi.fn(),setMarkerIcon:vi.fn(),vehicleIcon:vi.fn(),
    vehicleDisplayName:(item: any)=>`화물차 ${item.vehicleId}호`,uiText:(value: string)=>value,formatSpeed:vi.fn(),
    loadSelectedTrip:vi.fn(),selectRecordingTrip:vi.fn(),loadTripRecordings:vi.fn(),
    sameLiveTarget:(view: any,item: any)=>view?.markerKey===item?.telemetry?.external_id,
    releaseLiveMarker:vi.fn(),fitLivePanelToVideo:vi.fn(),refreshLiveMarkerIcons:vi.fn(),
    refreshMapLayout:vi.fn(),renderLiveTelemetryStatus:vi.fn(),
    browserReachableUrl:(url: string)=>url,
    createLiveView:(item: any,frameOrigin: string)=>({item,frameOrigin,vehicleId:item.vehicleId,markerKey:item.telemetry.external_id}),
    createServerPlaybackView,
    updateLiveTitle:vi.fn(),setLiveViewLoading:vi.fn(),syncLiveColorMode:vi.fn(),renderVehicleFields:vi.fn(),
    placeLivePanel:vi.fn(()=>expect(livePanel.hidden).toBe(true)),
    clearInterval:vi.fn(),setInterval:vi.fn(()=>1),
  };
  runInNewContext(['matchesLiveTarget','isLiveRecordingTabActive','retargetLiveView','selectVehicle','stopLiveView','openLiveView'].map(appFunction).join('\n'),context);
  return {context,element,chooseTab,livePanel,navigations,streaming};
}

describe('live preview and saved recordings',()=>{
  it('opens server footage without choosing a fleet vehicle',()=>{
    const {context,navigations,livePanel}=setup('live');
    context.bootstrap.videoSource={mode:'server',vehicleId:'server'};
    context.selected=null;
    context.openLiveView();
    expect(navigations).toHaveLength(1);
    expect(livePanel.hidden).toBe(false);
    expect(context.liveView.markerKey).toBe('server:dataset');
    expect(context.liveView.item.telemetry.latitude).toBeNull();
    expect(context.liveView.serverPlayback).toBe(true);
  });

  it('keeps server playback independent when a fixed fleet vehicle is selected',()=>{
    const {context,navigations}=setup('live');
    context.bootstrap.videoSource={mode:'server',vehicleId:'server'};
    context.openLiveView();
    const view=context.liveView;
    context.retargetLiveView({vehicleId:'2',telemetry:{external_id:'fixed:2',latitude:35,longitude:129}});
    expect(context.liveView).toBe(view);
    expect(navigations).toHaveLength(1);
  });
  it('keeps the loaded recording when its vehicle is selected again',()=>{
    const {context,streaming,navigations}=setup();
    context.replayTripId='21';context.replayTimeline=[{start:0,duration:10}];
    context.selectVehicle({...streaming,tripId:'21'});
    expect(context.loadTripRecordings).not.toHaveBeenCalled();
    expect(context.selectRecordingTrip).toHaveBeenCalledWith('21');
    expect(navigations).toEqual([]);
  });
  it('clears the old recording when selecting a vehicle with no trip',()=>{
    const {context,streaming}=setup();
    context.replayTripId='21';context.replayTimeline=[{start:0,duration:10}];
    context.selectVehicle(streaming);
    expect(context.loadTripRecordings).toHaveBeenCalledWith('');
  });
  it('loads a different vehicle trip and retries a trip with no playable recordings',()=>{
    const {context,streaming}=setup();
    context.replayTripId='21';context.replayTimeline=[{start:0,duration:10}];
    context.selectVehicle({...streaming,tripId:'22'});
    expect(context.loadTripRecordings).toHaveBeenCalledWith('22');
    context.loadTripRecordings.mockClear();context.replayTimeline=[];
    context.selectVehicle({...streaming,tripId:'21'});
    expect(context.loadTripRecordings).toHaveBeenCalledWith('21');
    context.loadTripRecordings.mockClear();context.replayTimeline=[{start:0,duration:10}];context.replayIndex=-1;
    context.selectVehicle({...streaming,tripId:'21'});
    expect(context.loadTripRecordings).toHaveBeenCalledWith('21');
  });
  it('keeps saved recordings selected when switching to a streaming vehicle',()=>{
    const {context,element,livePanel,navigations,streaming}=setup();
    context.selectVehicle(streaming);
    expect(context.selected).toBe(streaming);
    expect(context.liveView).toBeNull();
    expect(livePanel.hidden).toBe(true);
    expect(navigations).toEqual([]);
    expect(element('#recording-saved-tab').getAttribute('aria-pressed')).toBe('true');
    expect(element('#recording-live-tab').focus).not.toHaveBeenCalled();
  });

  it('hides the previous floating preview before tearing down its iframe',()=>{
    const {context,element,livePanel,navigations,streaming}=setup('saved',true);
    context.selectVehicle(streaming);
    expect(context.liveView).toBeNull();
    expect(livePanel.hidden).toBe(true);
    expect(navigations).toEqual([{url:'about:blank',hidden:true}]);
    expect(element('#recording-live-tab').focus).not.toHaveBeenCalled();
  });

  it('blocks every preview-open entry point while saved recordings is selected',()=>{
    const {context,navigations,streaming,element}=setup();
    context.selected=streaming;
    // Also reject an inconsistent content state, rather than flashing a preview.
    element('#recording-live-content').hidden=false;
    context.openLiveView();
    expect(context.liveView).toBeNull();
    expect(navigations).toEqual([]);
    expect(context.liveMapFollower.begin).not.toHaveBeenCalled();
    expect(context.placeLivePanel).not.toHaveBeenCalled();
  });

  it('opens the selected stream only after returning to the live tab',()=>{
    const {context,chooseTab,livePanel,navigations,streaming}=setup();
    context.selectVehicle(streaming);
    chooseTab('live');
    context.openLiveView();
    expect(context.liveView.vehicleId).toBe('2');
    expect(context.placeLivePanel).toHaveBeenCalledOnce();
    expect(livePanel.hidden).toBe(false);
    expect(navigations).toEqual([{url:'https://vision.example/live?autostart=1&embedded=1',hidden:false}]);
  });

  it('continues opening streaming vehicles automatically on the live tab',()=>{
    const {context,livePanel,streaming,navigations}=setup('live');
    context.selectVehicle(streaming);
    expect(context.liveView.vehicleId).toBe('2');
    expect(livePanel.hidden).toBe(false);
    expect(navigations).toHaveLength(1);
  });

  it('returns focus to the saved tab only when focus was inside the closed preview',()=>{
    const {context,element,livePanel}=setup('saved',true);
    context.document.activeElement=livePanel;
    context.stopLiveView();
    expect(element('#recording-saved-tab').focus).toHaveBeenCalledWith({preventScroll:true});
    expect(element('#recording-live-tab').focus).not.toHaveBeenCalled();
  });
});
