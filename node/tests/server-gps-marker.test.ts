import { describe, expect, it, vi } from 'vitest';
import { createServerPlaybackView, acceptLiveTelemetry, applyLiveTelemetry, describeLiveTelemetry, withServerPlaybackVehicle, withPresentedTelemetry } from '../operator-web/live-telemetry.js';
import { createLiveMapFollower } from '../operator-web/live-map.js';
import { vehicleDisplayName } from '../operator-web/dashboard-ui.js';
import { fleetPosition } from '../operator-web/fleet-view.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

describe('server dataset GPS marker',()=>{
  it('keeps the GPS vehicle in normal monitoring snapshots after fleet polls and closing preview',()=>{
    const view=createServerPlaybackView({vehicleId:'2'},'https://vision');
    const fleet=[{vehicleId:'2',telemetry:{external_id:'fleet:2',latitude:35,longitude:129}}];
    const item=withPresentedTelemetry(view.item,{telemetry:{gps:{latitude:36,longitude:128}}},1000);
    const displayed=withServerPlaybackVehicle(fleet,item);
    expect(displayed).toHaveLength(2);
    expect(vehicleDisplayName(displayed[1])).toBe('서버 영상 · GPS');
    expect(fleetPosition(displayed[1])).toEqual([36,128]);
    expect(displayed[1].vehicleId).toBeNull();
    expect(withServerPlaybackVehicle(displayed,item)).toHaveLength(2);
    expect(withServerPlaybackVehicle([],item)[0]).toBe(item);
    expect(fleet[0].telemetry.latitude).toBe(35);
  });

  it('shows the server GPS vehicle in the dropdown before and after the first GPS frame',()=>{
    const source=readFileSync(new URL('../../operator-web/app.js',import.meta.url),'utf8');
    const begin=source.indexOf('function renderVehiclePickers(');
    const end=source.indexOf('\n}',begin)+2;
    const pickers=[{replaceChildren:vi.fn(),options:[{}],add:vi.fn()}];
    const context:any={vehiclePickers:pickers,vehiclePickerSignature:'',fleetPosition,
      vehiclePickerLabel:vehicleDisplayName,syncVehiclePickers:vi.fn(),
      Option:function(this:any,label:string,value:string){this.label=label;this.value=value;}};
    runInNewContext(source.slice(begin,end),context);
    const view=createServerPlaybackView({},'https://vision');
    context.renderVehiclePickers([view.item]);
    expect(pickers[0].add).toHaveBeenCalledWith(expect.objectContaining({label:'서버 영상 · GPS',value:'server:dataset'}));
    const item=withPresentedTelemetry(view.item,{telemetry:{gps:{latitude:36,longitude:128}}});
    context.renderVehiclePickers([item]);
    expect(pickers[0].add).toHaveBeenCalledTimes(1);
  });

  it('uses presented GPS and seeks backwards without moving a fixed fleet vehicle',()=>{
    const origin='https://vision.example';
    const frameWindow={};
    // A previously configured fleet ID must not make the dataset share its marker.
    const view=createServerPlaybackView({vehicleId:'2'},origin);
    const fixedMarker={setLatLng:vi.fn(),getLatLng:()=>({lat:35,lng:129})};
    const markers=new Map<string,any>([['fleet:2',{marker:fixedMarker,item:{vehicleId:'2'}}]]);
    const datasetMarker={setLatLng:vi.fn(),getLatLng:()=>({lat:0,lng:0})};
    const map={options:{},getZoom:()=>15,setView:vi.fn(),panTo:vi.fn(),on:vi.fn()};
    const follower=createLiveMapFollower({map,markers,createEntry:(item:any)=>({item,marker:datasetMarker}),now:()=>1000});
    follower.begin(view);
    expect(map.setView).not.toHaveBeenCalled();
    for(const [epoch,latitude] of [[1,36],[2,35.5]]){
      const message=acceptLiveTelemetry(view,{origin,source:frameWindow,data:{
        type:'live-vehicle-telemetry',epoch,seq:0,
        recording:{vehicleId:'2',recordingSessionId:'server-dataset'},
        telemetry:{status:'ok',gps:{latitude,longitude:128}},
      }},frameWindow,1000);
      expect(message).not.toBeNull();
      follower.update(applyLiveTelemetry(view,message,1000));
      expect(datasetMarker.setLatLng).toHaveBeenLastCalledWith([latitude,128]);
    }
    expect(fixedMarker.setLatLng).not.toHaveBeenCalled();
    expect(markers.has('server:dataset')).toBe(true);
    expect(describeLiveTelemetry(view,{},10000).text).toContain('holding last GPS position');
  });
});
