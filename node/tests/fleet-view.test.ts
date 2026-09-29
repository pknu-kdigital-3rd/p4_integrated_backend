import {describe, expect, it, vi} from 'vitest';
// @ts-expect-error Plain browser JavaScript module.
import {fleetPosition, createFleetViewport} from '../../operator-web/fleet-view.js';

describe('normal fleet viewport',()=>{
  const item=(latitude:unknown,longitude:unknown)=>({telemetry:{latitude,longitude}});
  it('normalizes numeric coordinates and excludes missing or invalid positions',()=>{
    expect(fleetPosition(item('35.2','129.1'))).toEqual([35.2,129.1]);
    for(const bad of [null,undefined,'',NaN,Infinity,91])expect(fleetPosition(item(bad,129))).toBeNull();
    expect(fleetPosition(item(35,181))).toBeNull();
  });
  it('fits the first usable snapshot, without resetting the operator view on every poll',()=>{
    const map={invalidateSize:vi.fn(),fitBounds:vi.fn()};
    const view=createFleetViewport(map);
    view.fit([],{initial:true});
    view.fit([item(null,null),item(35.2,129.1)],{initial:true});
    view.fit([item(35.3,129.2)],{initial:true});
    expect(map.fitBounds).toHaveBeenCalledTimes(1);
    expect(map.fitBounds.mock.calls[0]?.[0]).toEqual([[35.2,129.1]]);
    view.fit([item(35.3,129.2)]);
    expect(map.fitBounds).toHaveBeenCalledTimes(2);
  });
  it('restores the normal map location after virtual dispatch moves the shared map',()=>{
    const center={lat:35.2,lng:129.1};
    const map={getCenter:()=>center,getZoom:()=>13,invalidateSize:vi.fn(),setView:vi.fn()};
    const view=createFleetViewport(map);
    view.save();view.restore();view.restore();
    expect(map.setView).toHaveBeenCalledExactlyOnceWith(center,13,{animate:false});
  });
});
