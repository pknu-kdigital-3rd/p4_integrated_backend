# v19 Virtual Routing and Dispatch ERD

This document supersedes the virtual-domain part of `VIRTUAL_DISPATCH_DETAILED_PLAN.md` with the tables implemented by migration `20260919120000_virtual_dispatch`.

The virtual domain is intentionally separate from real trip telemetry, Android publishing, Go relay state, vision inference, and MinIO recording. A virtual vehicle is a `vehicle` row with `vehicle_source = 'VIRTUAL'`; its authoritative position lives in `virtual_vehicle_state` and is never inserted into `vehicle_position`.

```mermaid
erDiagram
  VEHICLE ||--o| VIRTUAL_VEHICLE_SETTINGS : configures
  VEHICLE ||--o| VIRTUAL_VEHICLE_STATE : has
  VIRTUAL_SCENARIO ||--o{ VIRTUAL_ROUTE_DRAFT : owns
  VIRTUAL_SCENARIO ||--o{ VIRTUAL_DISPATCH_REQUEST : receives
  VIRTUAL_SCENARIO ||--o{ VIRTUAL_TRIP : contains
  VEHICLE ||--o{ VIRTUAL_ROUTE_DRAFT : selected
  VEHICLE ||--o{ VIRTUAL_DISPATCH_REQUEST : selected
  VEHICLE ||--o{ VIRTUAL_TRIP : drives
  VIRTUAL_ROUTE_DRAFT ||--o{ VIRTUAL_DISPATCH_REQUEST : becomes
  VIRTUAL_DISPATCH_REQUEST ||--o| VIRTUAL_TRIP : accepts
  VIRTUAL_TRIP ||--o{ VIRTUAL_ROUTE : versions
  VIRTUAL_TRIP ||--o{ VIRTUAL_TRIP_WAYPOINT : visits
  VIRTUAL_ROUTE ||--o| VIRTUAL_VEHICLE_STATE : active
  VIRTUAL_SCENARIO ||--o{ VIRTUAL_ROAD_RESTRICTION : overlays
  VIRTUAL_SCENARIO ||--o{ VIRTUAL_OPERATOR_EVENT : audits
  VIRTUAL_TRIP ||--o{ VIRTUAL_OPERATOR_EVENT : emits

  VIRTUAL_SCENARIO {
    bigint scenario_id PK
    varchar name
    varchar state
    integer restriction_revision
    integer auto_accept_after_seconds
  }
  VIRTUAL_ROUTE_DRAFT {
    bigint draft_id PK
    bigint scenario_id FK
    bigint selected_vehicle_id FK
    jsonb origin_destination_waypoints
    jsonb route_geojson
    jsonb directed_itinerary
    varchar graph_version
    integer restriction_revision
    timestamptz expires_at
  }
  VIRTUAL_DISPATCH_REQUEST {
    bigint request_id PK
    bigint selected_vehicle_id FK
    bigint draft_id FK
    varchar state "PENDING | ACCEPTED | REJECTED | EXPIRED"
    timestamptz accept_at
    varchar idempotency_key UK
    bigint accepted_trip_id UK
  }
  VIRTUAL_TRIP {
    bigint virtual_trip_id PK
    bigint scenario_id FK
    bigint vehicle_id FK
    varchar state "DRIVING | PAUSED | REROUTING | BLOCKED_AWAITING_OPERATOR | NO_ROUTE | COMPLETED | CANCELLED"
    bigint active_route_id
    integer route_version
    integer command_version
    integer trip_revision
  }
  VIRTUAL_ROUTE {
    bigint route_id PK
    bigint virtual_trip_id FK
    integer route_version
    jsonb route_geojson
    jsonb directed_itinerary
    varchar graph_version
    boolean is_current
  }
  VIRTUAL_VEHICLE_STATE {
    bigint vehicle_id PK
    bigint scenario_id FK
    bigint virtual_trip_id UK
    bigint active_route_id UK
    varchar sim_status
    varchar current_edge_id
    double offset_m
    jsonb last_position
    bigint sim_elapsed_ms
  }
  VIRTUAL_ROAD_RESTRICTION {
    bigint restriction_id PK
    bigint scenario_id FK
    varchar kind "BLOCKED | HEAVY_PENALTY"
    jsonb geometry
    jsonb affected_directed_edge_ids
    jsonb affected_physical_segment_ids
    integer revision
    boolean is_active
  }
```

Acceptance is serialized by a serializable Prisma transaction and the partial unique active-trip index. The persistent worker scans due requests and advances `virtual_vehicle_state`; browser polling only renders snapshots and cannot write coordinates.
