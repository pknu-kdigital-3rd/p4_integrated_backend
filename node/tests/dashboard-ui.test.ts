import { describe, expect, it } from 'vitest';
// @ts-expect-error The operator frontend remains plain browser JavaScript.
import { matchesVehicle, vehicleStatus } from '../../operator-web/dashboard-ui.js';

describe('dashboard fleet presentation', () => {
  it('maps backend vehicle states without guessing an unknown state', () => {
    expect(vehicleStatus({vehicleStatus:'DRIVING'})).toBe('running');
    expect(vehicleStatus({vehicleStatus:'READY'})).toBe('ready');
    expect(vehicleStatus({vehicleStatus:'STOPPED'})).toBe('ready');
    expect(vehicleStatus({vehicleStatus:'MAINTENANCE'})).toBe('maintenance');
    expect(vehicleStatus({vehicleStatus:'OFFLINE'})).toBe('offline');
    expect(vehicleStatus({vehicleStatus:'NEW_STATE'})).toBe('unknown');
    expect(vehicleStatus({})).toBe('unknown');
  });
  it('prefers the registered vehicle state over telemetry metadata', () => {
    expect(vehicleStatus({vehicleStatus:'OFFLINE',telemetry:{source_metadata:{state:'ACTIVE'}}})).toBe('offline');
    expect(vehicleStatus({telemetry:{source_metadata:{state:'ACTIVE'}}})).toBe('running');
  });
  it('searches real names, codes and external IDs, ignoring case and surrounding spaces', () => {
    const item={vehicleId:42,vehicleCode:'부산70가1234',vehicleName:'해운대 버스',telemetry:{external_id:'DEVICE:42'}};
    for(const query of ['1234','해운대',' device:42 ','42',''])expect(matchesVehicle(item,query)).toBe(true);
    expect(matchesVehicle(item,'서울')).toBe(false);
    expect(matchesVehicle({},'missing')).toBe(false);
  });
});
