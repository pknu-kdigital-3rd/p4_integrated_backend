import { describe, expect, it } from 'vitest';
// @ts-expect-error The operator frontend remains plain browser JavaScript.
import { matchesVehicle, vehicleStatus, vehicleDisplayName, vehicleDetailRows } from '../../operator-web/dashboard-ui.js';
// @ts-expect-error The operator frontend remains plain browser JavaScript.
import { withPresentedTelemetry } from '../../operator-web/live-telemetry.js';

describe('current replay vehicle details', () => {
  it.each([undefined, 'IN_PROGRESS'])('refreshes frame speed with trip status %s and separates reception from source time', (tripStatus) => {
    const item = { vehicleId: '3', vehicleStatus: 'READY', tripStatus, telemetry: {
      speed_kmh: 1, telemetry_source: 'RECORDED_GPS', observed_at_utc: '2026-08-27T05:56:10.772Z',
    } };
    const current = withPresentedTelemetry(item, { telemetry: { gps: { latitude: 35, longitude: 129, speed_kmh: 42.5, bearing_deg: 90 } } }, Date.parse('2026-10-05T06:00:00Z'));
    expect(vehicleDetailRows(current)).toContainEqual(['속도', '42.50 km/h']);
    expect(vehicleDetailRows(current)).toContainEqual(['최근 수신 시각', '2026-10-05T06:00:00.000Z']);
    expect(vehicleDetailRows(current)).toContainEqual(['원본 녹화 시각', '2026-08-27T05:56:10.772Z']);
    expect(item.telemetry.speed_kmh).toBe(1);
  });

  it('clears a missing current speed and ignores a frame without GPS', () => {
    const item = { telemetry: { speed_kmh: 10 } };
    expect(withPresentedTelemetry(item, { telemetry: { gps: null } })).toBe(item);
    expect(withPresentedTelemetry(item, { telemetry: { gps: { latitude: 35, longitude: 129 } } }).telemetry.speed_kmh).toBeNull();
  });
});

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
  it('labels an outdated BIMS fix as GPS delay even when the registered vehicle is driving', () => {
    expect(vehicleStatus({vehicleStatus:'DRIVING',telemetry:{source_metadata:{state:'stale'}}})).toBe('stale');
  });
  it('searches real names, codes and external IDs, ignoring case and surrounding spaces', () => {
    const item={vehicleId:42,vehicleCode:'부산70가1234',vehicleName:'해운대 버스',telemetry:{external_id:'DEVICE:42'}};
    for(const query of ['1234','해운대',' device:42 ','42',''])expect(matchesVehicle(item,query)).toBe(true);
    expect(matchesVehicle(item,'서울')).toBe(false);
    expect(matchesVehicle({},'missing')).toBe(false);
  });
});

describe('Korean truck display names', () => {
  it('uses the vehicle ID consistently for every vehicle source', () => {
    for(const vehicleSource of ['BIMS','CUSTOM','VIRTUAL']) {
      expect(vehicleDisplayName({vehicleId:'42',vehicleSource,vehicleCode:'BIMS-99',vehicleName:'English vehicle'})).toBe('화물차 42호');
    }
    expect(vehicleDisplayName({vehicleId:'9007199254740993',vehicleName:'해운대 버스'})).toBe('화물차 9007199254740993호');
  });
  it('falls back to the code or external number when no registered ID is available', () => {
    expect(vehicleDisplayName({vehicleCode:'CUSTOM-TRUCK-01'})).toBe('화물차 1호');
    expect(vehicleDisplayName({telemetry:{external_id:'DEVICE:09'}})).toBe('화물차 9호');
    expect(vehicleDisplayName({})).toBe('화물차');
  });
  it('finds the Korean display name as well as the original identity without changing it', () => {
    const item={vehicleId:'42',vehicleCode:'CUSTOM-TRUCK-01',vehicleName:'Custom Truck 1'};
    expect(matchesVehicle(item,'화물차 42호')).toBe(true);
    expect(matchesVehicle(item,'CUSTOM-TRUCK-01')).toBe(true);
    expect(matchesVehicle(item,'Custom Truck')).toBe(true);
    expect(item.vehicleCode).toBe('CUSTOM-TRUCK-01');
    expect(item.vehicleName).toBe('Custom Truck 1');
  });
});

describe('vehicle speed format', () => {
  it('shows two decimal places and a dash when unknown', async () => {
    const { formatSpeed } = await import('../../operator-web/dashboard-ui.js');
    expect(formatSpeed(42.3456)).toBe('42.35 km/h');
    expect(formatSpeed(7)).toBe('7.00 km/h');
    expect(formatSpeed('36')).toBe('36.00 km/h');
    expect(formatSpeed(null)).toBe('— km/h');
    expect(formatSpeed('')).toBe('— km/h');
  });
});

describe('vehicle status with a running trip', () => {
  it('shows a vehicle with a trip in progress as running even if its stored status is READY', () => {
    expect(vehicleStatus({ vehicleStatus: 'READY', tripStatus: 'IN_PROGRESS' })).toBe('running');
    expect(vehicleStatus({ vehicleStatus: 'READY', tripStatus: 'READY' })).toBe('ready');
    expect(vehicleStatus({ vehicleStatus: 'READY', tripStatus: 'IN_PROGRESS', telemetry: { source_metadata: { state: 'stale' } } })).toBe('stale');
  });
});
