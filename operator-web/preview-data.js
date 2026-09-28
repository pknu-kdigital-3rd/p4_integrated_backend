export const PREVIEW_MODE = new URLSearchParams(location.search).get('preview') === '1';

const sampleRoute = {
  type: 'Feature',
  properties: {},
  geometry: {
    type: 'LineString',
    coordinates: [
      [129.0756, 35.1796], [129.0818, 35.1732], [129.0923, 35.1681],
      [129.1035, 35.1608], [129.1144, 35.1550]
    ]
  }
};

export const PREVIEW_ROUTE = sampleRoute;

export const PREVIEW_VEHICLES = {
  vehicles: [
    {
      vehicleId: 'preview-1', vehicleCode: 'BUS-101', vehicleName: 'Busan sample bus',
      vehicleSource: 'BIMS', vehicleStatus: 'ACTIVE', tripId: null,
      telemetry: {
        external_id: 'preview-bus-101', telemetry_source: 'BIMS',
        latitude: 35.1796, longitude: 129.0756, speed_kmh: 38,
        observed_at_utc: '2026-09-28T09:00:00Z', source_metadata: {}
      },
      plannedRoute: { routeSource: 'preview fixture', routeGeojson: sampleRoute }
    },
    {
      vehicleId: 'preview-2', vehicleCode: 'BUS-202', vehicleName: 'Waterfront sample bus',
      vehicleSource: 'BIMS', vehicleStatus: 'ACTIVE', tripId: null,
      telemetry: {
        external_id: 'preview-bus-202', telemetry_source: 'BIMS',
        latitude: 35.1562, longitude: 129.1138, speed_kmh: 24,
        observed_at_utc: '2026-09-28T09:00:00Z', source_metadata: {}
      },
      plannedRoute: null
    }
  ]
};

export const PREVIEW_VIRTUAL_VEHICLES = [
  {
    vehicleId: 'virtual-preview-1', vehicleCode: 'SIM-01', vehicleName: 'Harbor route',
    vehicleStatus: 'MOVING', following: { autoFollowEnabled: true },
    state: {
      simStatus: 'MOVING', speedKmh: 50,
      lastPosition: { lat: 35.1732, lon: 129.0818 },
      virtualTripId: 'virtual-trip-preview-1', activeRouteId: 'virtual-route-preview-1',
      trip: {
        virtualTripId: 'virtual-trip-preview-1', state: 'IN_PROGRESS',
        routes: [{ routeId: 'virtual-route-preview-1', routeVersion: 1,
          routeGeojson: sampleRoute, isCurrent: true }]
      }
    }
  },
  {
    vehicleId: 'virtual-preview-2', vehicleCode: 'SIM-02', vehicleName: 'Standby vehicle',
    vehicleStatus: 'READY', state: {
      simStatus: 'READY', speedKmh: 25,
      lastPosition: { lat: 35.1649, lon: 129.0931 }
    }
  }
];

export const PREVIEW_RESTRICTIONS = [
  {
    restrictionId: 'preview-heavy-penalty', kind: 'HEAVY_PENALTY', penaltyFactor: 3,
    revision: 1, isActive: true,
    geometry: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[
      [129.06, 35.179], [129.068, 35.179], [129.068, 35.185], [129.06, 35.185], [129.06, 35.179]
    ]] } }
  },
  {
    restrictionId: 'preview-blocked-road', kind: 'BLOCKED', revision: 1, isActive: true,
    geometry: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[
      [129.048, 35.179], [129.056, 35.179], [129.056, 35.185], [129.048, 35.185], [129.048, 35.179]
    ]] } }
  }
];
