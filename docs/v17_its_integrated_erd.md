# v17 ITS Integrated ERD

Current schema: `node/prisma/schema.prisma` (13 tables). This document supersedes earlier ERDs for the integrated product while preserving them as historical records.

```mermaid
erDiagram
  PLATFORM_ACCOUNT ||--o{ ALERT : acknowledges
  VEHICLE ||--o{ TRIP : operates
  VEHICLE ||--o{ VEHICLE_POSITION : reports
  VEHICLE ||--o{ DETECTION_EVENT : produces
  TRIP ||--o{ ROUTE : plans
  TRIP ||--o{ VEHICLE_POSITION : contains
  TRIP ||--o{ TRIP_VIDEO : records
  ROUTE ||--o{ ROUTE_DEVIATION : measures
  OBJECT_CLASS ||--o{ DETECTION_EVENT : classifies
  DETECTION_EVENT ||--o{ EVENT_IMAGE : captures
  DETECTION_EVENT ||--o{ ALERT : raises
  VEHICLE ||--o{ TRANSPORT_GOAL : receives

  VEHICLE {
    bigint vehicle_id PK
    varchar vehicle_code UK
    varchar vehicle_source "CUSTOM | BIMS"
    varchar external_id "provider identity"
    varchar vehicle_status
  }
  ROUTE {
    bigint route_id PK
    bigint trip_id FK
    varchar route_type "lifecycle/version semantics"
    varchar route_source "BIMS_LINE | OPTIMAL_PATH"
    jsonb source_metadata
    jsonb route_geojson
  }
  VEHICLE_POSITION {
    bigint position_id PK
    bigint vehicle_id FK
    bigint trip_id FK
    geography location
    varchar telemetry_source "BIMS_LIVE | BIMS_REPLAY | DEVICE_GPS | RECORDED_GPS"
    timestamptz recorded_at
  }
```

Node owns all persisted entities. The routing/tracking service supplies transient normalized observations; only authoritative source observations are eligible for persistence. Browser interpolation frames are never stored.
