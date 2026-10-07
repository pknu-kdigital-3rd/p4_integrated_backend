import { describe, expect, it, vi } from 'vitest';
import { createServerPlaybackView, acceptLiveTelemetry, applyLiveTelemetry, describeLiveTelemetry } from '../operator-web/live-telemetry.js';
import { createLiveMapFollower } from '../operator-web/live-map.js';

describe('server dataset GPS marker',()=>{
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
