# v17 ITS Integrated ERD

> Historical. Superseded by `v18_its_integrated_erd.md` (Android/device GPS provenance on `vehicle_position`).

Schema at v17: `node/prisma/schema.prisma` (13 tables). This document supersedes earlier ERDs for the integrated product while preserving them as historical records.

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
  TRIP_VIDEO {
    bigint trip_video_id PK
    bigint trip_id FK
    varchar recording_session_id
    integer segment_index
    varchar storage_bucket
    varchar object_key UK
    varchar upload_status "FINALIZED | FAILED"
    bigint relay_epoch
    bigint start_seq
    bigint end_seq
    bigint start_pts_90k
    bigint end_pts_90k
    timestamptz started_at
    timestamptz ended_at
    integer duration_sec
  }
```

`trip_video` stores one independently playable H.264 MP4 segment per row. The durable object identity is `(storage_bucket, object_key)`; `video_url` remains nullable only for legacy compatibility and never stores a presigned URL. Legacy rows without MinIO objects are retained with `upload_status=FAILED` and a `storage_bucket=legacy` marker.

Node owns all persisted entities. The routing/tracking service supplies transient normalized observations; only authoritative source observations are eligible for persistence. Browser interpolation frames are never stored.
