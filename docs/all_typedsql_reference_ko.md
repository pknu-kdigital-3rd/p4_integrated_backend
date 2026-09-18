# v15 Prisma TypedSQL 전체 SQL 레퍼런스

> 대상: v15 Node/Express Control Backend  
> SQL 파일 수: **11개**  
> 구성: **핵심 10개 + 선택 기능 1개 (`findNearbyVehicles.sql`)**

---

# 1. 전체 목록

```text
prisma/sql/
├── createTrip.sql
├── getTripWithLocations.sql
├── insertVehiclePosition.sql
├── getLatestVehiclePosition.sql
├── getTripPositionTrack.sql
├── insertDeviceGpsPosition.sql            (v18 추가, 25절)
├── getLatestReceivedVehiclePosition.sql   (v18 추가, 25절)
├── saveRouteFromGeoJson.sql
├── getCurrentRouteDeviation.sql
├── insertRouteDeviationIfExceeded.sql
├── getRouteDeviations.sql
├── getDetectionEventsForReplayWindow.sql
└── findNearbyVehicles.sql
```

---

# 2. 한눈에 보는 역할

| SQL | 분류 | Write/Read | PostGIS 기능 | 우선순위 |
|---|---|---:|---|---|
| `createTrip.sql` | Trip | Write | Point 생성 | Core |
| `getTripWithLocations.sql` | Trip | Read | ST_X/ST_Y | Core |
| `insertVehiclePosition.sql` | Telemetry | Write | Point 생성 | Core |
| `getLatestVehiclePosition.sql` | Telemetry | Read | ST_X/ST_Y | Core |
| `getTripPositionTrack.sql` | Telemetry/Replay | Read | ST_X/ST_Y | Core |
| `saveRouteFromGeoJson.sql` | Route | Write | GeoJSON → LineString | Core |
| `getCurrentRouteDeviation.sql` | Route Control | Read/Calculation | ST_Distance | Core |
| `insertRouteDeviationIfExceeded.sql` | Route Control | Conditional Write | ST_Distance + Point copy | Core |
| `getRouteDeviations.sql` | History/Replay | Read | ST_X/ST_Y | Core |
| `getDetectionEventsForReplayWindow.sql` | Vision Read/Replay | Read | nullable ST_X/ST_Y | Core |
| `findNearbyVehicles.sql` | Spatial Search | Read | ST_DWithin + ST_Distance | Optional |

---

# 3. 아키텍처 경계

## Node / Prisma TypedSQL이 담당

```text
trip
vehicle_position
route
route_deviation
detection_event READ
```

## FastAPI Vision이 담당

```text
frame_inference INSERT
detection_event INSERT
event_image INSERT
vision-origin alert INSERT
```

따라서 11개 SQL에는 의도적으로 다음 파일이 없다.

```text
insertDetectionEvent.sql
insertFrameInference.sql
```

이 두 write path를 Node Prisma TypedSQL에 추가하면 v15 서비스 ownership을 깨게 된다.

---

# 4. 공통 함수 사전

## `ST_MakePoint`

```sql
ST_MakePoint(longitude, latitude)
```

WGS84 GPS Point의 X/Y를 만든다.

---

## `ST_SetSRID`

```sql
ST_SetSRID(geometry, 4326)
```

이미 WGS84인 geometry에 EPSG:4326 SRID를 지정한다. 좌표 변환 함수가 아니다.

---

## `::geography`

```sql
...::geography
```

PostGIS geography 타입으로 cast한다. meter 기반 distance query에 유리하다.

---

## `ST_X` / `ST_Y`

```sql
ST_X(location::geometry)  → longitude
ST_Y(location::geometry)  → latitude
```

Unsupported PostGIS 값을 API-friendly numeric value로 변환한다.

---

## `ST_GeomFromGeoJSON`

```sql
ST_GeomFromGeoJSON(geojson)
```

GeoJSON geometry fragment를 geometry로 변환한다.

---

## `ST_Distance`

```sql
ST_Distance(point_geography, line_geography)
```

차량 Point와 route LineString 사이 최단 거리를 계산한다.

---

## `ST_DWithin`

```sql
ST_DWithin(location, target, radiusMeters)
```

radius 안에 있는지 검사한다. 공간 인덱스를 활용할 수 있는 대표적인 radius predicate다.

---

# 5. `createTrip.sql`

## 목적

trip 생성과 동시에 출발지/목적지를 PostGIS Point로 저장한다.

## Parameter

| 위치 | 이름 | 의미 |
|---:|---|---|
| `$1` | `vehicleId` | 차량 ID |
| `$2` | `driverId?` | 운전자 ID |
| `$3` | `originName?` | 출발지명 |
| `$4` | `originAddress?` | 출발지 주소 |
| `$5` | `originLongitude?` | 출발 경도 |
| `$6` | `originLatitude?` | 출발 위도 |
| `$7` | `destinationName` | 목적지명 |
| `$8` | `destinationAddress?` | 목적지 주소 |
| `$9` | `destinationLongitude` | 목적 경도 |
| `$10` | `destinationLatitude` | 목적 위도 |
| `$11` | `plannedStartAt?` | 예정 출발 시각 |

## 결과

새 `tripId`와 기본 trip metadata를 반환한다.

## 특징

- origin 좌표는 optional
- destination 좌표는 required
- 초기 `trip_status = READY`
- location 값을 application에서 WKT로 만들지 않고 SQL에서 geography로 생성

---

# 6. `getTripWithLocations.sql`

## 목적

trip 상세 조회 시 PostGIS origin/destination을 숫자 좌표로 반환한다.

## Parameter

```text
$1 tripId
```

## 반환 좌표

```text
originLat
originLng
destinationLat
destinationLng
```

## 용도

- trip detail
- map marker
- route planning UI
- replay metadata

---

# 7. `insertVehiclePosition.sql`

## 목적

GPS telemetry를 `vehicle_position`에 저장한다.

## Parameter

```text
vehicleId
tripId?
longitude
latitude
speedKmh?
headingDeg?
recordedAt
```

## 핵심

```sql
ST_SetSRID(ST_MakePoint(longitude, latitude),4326)::geography
```

## 반환

```text
positionId
```

이 `positionId`는 동일 GPS sample을 route deviation 검사에 연결하는 키로 사용한다.

---

# 8. `getLatestVehiclePosition.sql`

## 목적

차량의 가장 최근 위치를 dashboard/API에 제공한다.

## Parameter

```text
$1 vehicleId
```

## 정렬 규칙

```text
recorded_at DESC
position_id DESC
```

## 반환

```text
positionId
vehicleId
tripId
lat/lng
speedKmh
headingDeg
recordedAt
```

---

# 9. `getTripPositionTrack.sql`

## 목적

trip 내 특정 시간 구간의 GPS 궤적을 반환한다.

## Parameter

```text
$1 tripId
$2 fromTime
$3 toTime
```

## 이유

고빈도 위치 테이블 전체를 무제한 조회하지 않도록 bounded window를 사용한다.

## 정렬

```text
oldest → newest
```

## 사용처

```text
actual route polyline
replay telemetry
trip history
```

---

# 10. `saveRouteFromGeoJson.sql`

## 목적

routing result를 표시용 JSONB와 spatial calculation용 geography LineString으로 동시에 저장한다.

## Parameter

```text
tripId
routeVersion
routeType
distanceM?
durationSec?
encodedPolyline?
routeGeoJson
```

## routeGeoJson 규칙

입력은 다음과 같은 `LineString` geometry fragment여야 한다.

```json
{
  "type": "LineString",
  "coordinates": [
    [129.07, 35.17],
    [129.08, 35.18]
  ]
}
```

## 저장 형태

```text
route_geojson JSONB
route_line geography(LineString,4326)
```

## 주의

`saveRouteFromGeoJson.sql`은 기존 current route를 false로 변경하지 않는다. current route invariant는 Service transaction에서 관리한다.

---

# 11. `getCurrentRouteDeviation.sql`

## 목적

현재 차량 위치가 current route에서 몇 meter 떨어져 있는지 계산한다.

## Parameter

```text
$1 tripId
```

## 핵심

```sql
ST_Distance(vp.location, r.route_line)
```

## 반환

```text
positionId
vehicleId
routeId
deviationDistanceM
recordedAt
```

## 성격

- read/calculation query
- route_deviation INSERT는 하지 않음
- diagnostics와 current-state display에 적합

---

# 12. `insertRouteDeviationIfExceeded.sql`

## 목적

특정 GPS position과 route를 검사하여 임계 거리를 넘을 때만 route_deviation event를 저장한다.

## Parameter

```text
vehicleId
tripId
routeId
positionId
thresholdMeters
detectedAt
```

## 반환 semantics

```text
0 rows → threshold 미초과
1 row  → deviation 생성
```

## 핵심 장점

`positionId`와 `routeId`를 명시하므로 실제 어떤 GPS/route 쌍을 검사했는지 고정할 수 있다.

## 이후 처리

```text
deviation insert
    ↓
alert
    ↓
reroute
    ↓
new route
```

---

# 13. `getRouteDeviations.sql`

## 목적

trip 내 특정 시간 구간의 deviation history를 반환한다.

## Parameter

```text
tripId
fromTime
toTime
```

## 결과

```text
deviationId
routeId
deviationDistanceM
lat/lng
detectedAt
resolvedAt
recalculatedRouteId
```

## 사용처

- map marker
- history
- replay
- statistics

---

# 14. `getDetectionEventsForReplayWindow.sql`

## 목적

FastAPI Vision이 기록한 detection event 중 특정 replay capture-time 구간의 이벤트를 Node가 조회한다.

## Parameter

```text
tripId
fromCaptureTimestampNs
toCaptureTimestampNs
```

## 기준 timeline

```text
capture_timestamp_ns
```

Replay에서는 이것을 `video_time_anchor`의 `video_pts_us`로 매핑한다.

## 반환 정보

### identity

```text
sessionId
frameId
captureTimestampNs
```

### detection

```text
classId
trackId
className
displayName
confidence
distanceM
warningDistanceM
riskLevel
```

### location

```text
lat/lng nullable
```

### bbox

```text
bboxX1/Y1/X2/Y2
```

### audit

```text
pitchAtCaptureDeg
rollAtCaptureDeg
telemetrySource
```

## 중요

이 파일은 **SELECT 전용**이다. detection_event의 write owner는 FastAPI Vision이다.

---

# 15. `findNearbyVehicles.sql`

## 분류

```text
Optional spatial API
```

핵심 MVP 경로에 필수는 아니지만 PostGIS 공간 검색을 활용하는 대표 기능이다.

## 목적

입력 좌표와 radius를 기준으로 **각 차량의 최신 위치**가 반경 안에 있는 차량만 반환한다.

## Parameter

```text
$1 longitude
$2 latitude
$3 radiusMeters
```

## 핵심 1: target Point

```sql
ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
```

## 핵심 2: radius filter

```sql
ST_DWithin(vp.location, target, radiusMeters)
```

## 핵심 3: latest position 보장

단순히 과거 vehicle_position까지 radius 검색하면 다음 문제가 생긴다.

```text
10:00 차량이 target 근처
10:10 차량이 5km 이동

과거 10:00 row가 radius 안에 존재
        ↓
잘못하면 차량이 여전히 nearby로 표시됨
```

현재 SQL은 `NOT EXISTS` anti-join으로 더 최신 position이 없는 row만 남긴다.

```text
각 vehicle
    ↓
latest known position
    ↓
ST_DWithin
```

같은 `recorded_at`이 있을 경우 `position_id`가 큰 row를 최신으로 간주한다.

## 반환

```text
vehicleId
tripId
lat/lng
speedKmh
headingDeg
distanceM
recordedAt
```

## 정렬

```text
가까운 차량 → 먼 차량
```

---

# 16. 왜 `getReplayWindow.sql` 하나로 합치지 않았는가

Replay에 필요한 데이터는 서로 다른 ownership/access 특성을 가진다.

```text
trip_video             Prisma Client
video_time_anchor      Prisma Client / batch read
frame_inference        Prisma or appropriate read path
detection_event        TypedSQL
vehicle_position       TypedSQL
```

따라서 하나의 거대한 SQL에 모두 JOIN하기보다:

```text
ReplayService
    ↓
multiple repositories
    ↓
compose replay DTO
```

구조를 기본으로 한다.

향후 profiling 결과 단일 SQL이 명확한 이점을 보일 때에만 별도 `getReplayWindow.sql`을 최적화 쿼리로 도입하는 것이 좋다.

---

# 17. 추천 Repository 구조

```text
src/
├── trips/
│   └── trip.repository.ts
│       ├── createTrip
│       └── getTripWithLocations
│
├── telemetry/
│   └── vehicle-position.repository.ts
│       ├── insertVehiclePosition
│       ├── getLatestVehiclePosition
│       └── getTripPositionTrack
│
├── routes/
│   └── route.repository.ts
│       └── saveRouteFromGeoJson
│
├── deviations/
│   └── route-deviation.repository.ts
│       ├── getCurrentRouteDeviation
│       ├── insertRouteDeviationIfExceeded
│       └── getRouteDeviations
│
└── replay/
    └── detection-event.repository.ts
        └── getDetectionEventsForReplayWindow
```

Optional spatial query는 다음 중 하나에 둘 수 있다.

```text
vehicles/spatial repository
```

또는:

```text
statistics/spatial-query repository
```

프로젝트 전체에서 한 가지 규칙으로 통일한다.

---

# 18. Service workflow 매핑

## Trip 생성

```text
POST /trips
  ↓
Zod validation
  ↓
vehicle/driver validation
  ↓
createTrip.sql
```

## GPS ingest

```text
POST /telemetry/positions
  ↓
insertVehiclePosition.sql
  ↓
positionId
  ↓
route deviation service
```

## Route deviation

```text
positionId + current routeId
  ↓
insertRouteDeviationIfExceeded.sql
  ↓
if row exists
  ↓
alert + reroute
```

## Route save

```text
OSRM/A* response
  ↓
extract GeoJSON geometry
  ↓
saveRouteFromGeoJson.sql
```

## Replay

```text
tripId + capture time window
   ↓
getDetectionEventsForReplayWindow.sql
   +
getTripPositionTrack.sql
   +
video_time_anchor
   ↓
Replay DTO
```

---

# 19. 인덱스와 연계

11개 SQL의 성능은 다음 v15 index와 직접 관련된다.

```sql
CREATE INDEX idx_vehicle_position_vehicle_time
ON vehicle_position(vehicle_id, recorded_at DESC);

CREATE INDEX idx_vehicle_position_location
ON vehicle_position USING GIST(location);

CREATE INDEX idx_route_line
ON route USING GIST(route_line);

CREATE INDEX idx_route_deviation_trip_time
ON route_deviation(trip_id, detected_at DESC);

CREATE INDEX idx_route_deviation_location
ON route_deviation USING GIST(location);

CREATE INDEX idx_detection_event_trip_capture
ON detection_event(trip_id, capture_timestamp_ns);

CREATE INDEX idx_detection_event_location
ON detection_event USING GIST(location);
```

특히:

```text
findNearbyVehicles
    → vehicle_position.location GiST

getDetectionEventsForReplayWindow
    → (trip_id, capture_timestamp_ns)

getRouteDeviations
    → (trip_id, detected_at)
```

패턴과 잘 맞는다.

---

# 20. 공통 오류 패턴

## 20.1 longitude / latitude 순서 반전

잘못된 예:

```sql
ST_MakePoint(latitude, longitude)
```

올바른 예:

```sql
ST_MakePoint(longitude, latitude)
```

---

## 20.2 geography를 DTO에 직접 노출

가능하면 SQL에서 다음으로 변환한다.

```text
ST_X / ST_Y
ST_AsGeoJSON
```

---

## 20.3 전체 trip history 무제한 조회

피해야 한다.

```text
get all positions for 8-hour trip
```

대신:

```text
tripId + fromTime + toTime
```

---

## 20.4 full GeoJSON Feature를 `ST_GeomFromGeoJSON`에 전달

`saveRouteFromGeoJson.sql`에는 geometry fragment를 전달한다.

---

## 20.5 FastAPI write ownership을 Node SQL로 복제

피해야 할 파일:

```text
insertDetectionEvent.sql
insertFrameInference.sql
```

v15에서는 FastAPI persistence path가 writer다.

---

## 20.6 route save와 reroute transaction을 혼동

`saveRouteFromGeoJson.sql`은 route row insert다.

다음 전체 workflow를 SQL 한 파일에 강제로 넣지 않는다.

```text
provider call
old current false
new route insert
alert update
reroute state
```

Service orchestration과 짧은 DB transaction으로 나눈다.

---

# 21. `npx prisma generate --sql` 이후 확인사항

SQL 파일 변경 후 generated TypedSQL API를 다시 생성한다.

```bash
npx prisma generate --sql
```

체크할 사항:

- [ ] parameter nullable 여부가 예상과 일치
- [ ] `BIGINT` 결과가 JavaScript `bigint`로 생성되는 부분 확인
- [ ] numeric → Float가 필요한 곳에서 `::double precision` cast 확인
- [ ] geography raw result가 generated result에 남아 있지 않은지 확인
- [ ] SQL filename이 generated function name과 명확히 매핑되는지 확인
- [ ] 실제 migrated PostgreSQL/PostGIS DB에서 generation/integration test 수행

---

# 22. 권장 테스트 매트릭스

| SQL | 정상 테스트 | 경계/실패 테스트 |
|---|---|---|
| `createTrip` | 출발/목적지 저장 | origin NULL, 잘못된 destination |
| `getTripWithLocations` | 좌표 원복 | origin NULL |
| `insertVehiclePosition` | GPS 저장 | 경위도 순서/범위 |
| `getLatestVehiclePosition` | 최신 행 | timestamp tie |
| `getTripPositionTrack` | window track | 빈 window, 경계 timestamp |
| `saveRouteFromGeoJson` | LineString 생성 | Feature 입력, invalid geometry |
| `getCurrentRouteDeviation` | meter distance | current route 없음 |
| `insertRouteDeviationIfExceeded` | threshold 초과 insert | threshold 미만 0 row, route/position mismatch |
| `getRouteDeviations` | bounded history | empty range |
| `getDetectionEventsForReplayWindow` | capture range | location NULL, same timestamp multiple events |
| `findNearbyVehicles` | latest in radius | old point in radius/current point outside |

---

# 23. 최종 분류

## Core 10

```text
createTrip.sql
getTripWithLocations.sql
insertVehiclePosition.sql
getLatestVehiclePosition.sql
getTripPositionTrack.sql
saveRouteFromGeoJson.sql
getCurrentRouteDeviation.sql
insertRouteDeviationIfExceeded.sql
getRouteDeviations.sql
getDetectionEventsForReplayWindow.sql
```

## Optional 1

```text
findNearbyVehicles.sql
```

Optional이라는 의미는 SQL 자체가 덜 중요하다는 뜻이 아니라, v15 MVP의 필수 control/replay path 없이도 시스템이 먼저 동작할 수 있다는 뜻이다.

---

# 24. 최종 구조 요약

```text
                       Node / Express
                             │
                 ┌───────────┴───────────┐
                 │                       │
           Prisma Client             TypedSQL
                 │                       │
       normal relational          PostGIS operations
                 │                       │
                 └───────────┬───────────┘
                             ▼
                    PostgreSQL + PostGIS
                             ▲
                             │
                 FastAPI Vision writer
                 frame_inference
                 detection_event
```

11개 SQL은 이 경계를 유지하면서 다음 네 가지 문제를 해결한다.

```text
GPS Point storage/read
Route LineString storage
Point-to-route distance
Spatial history/replay/search
```

---

# 25. v18 추가: Android/디바이스 GPS (`vehicle_position` v18)

스키마 변경은 `docs/v18_its_integrated_erd.md`와 마이그레이션
`20260918000000_vehicle_position_device_telemetry`를 참조한다.
`vehicle_position`에 `recording_session_id`, `source_timestamp_ns`, `altitude_m`,
`horizontal_accuracy_m`, `received_at`이 추가되었다.

## `insertDeviceGpsPosition.sql`

- 목적: 미디어 릴레이가 `POST /internal/telemetry/gps`로 전달한 **원본 GPS fix 1개 = 1행** 저장.
  보간/예측된 지도 표시 좌표는 절대 저장하지 않는다.
- `speed_kmh = speed_mps * 3.6`, `heading_deg = GPS bearing_deg` (IMU yaw 아님).
- `recorded_at` = 원본 GPS UTC(`utc_epoch_ms`, 없으면 `received_at`),
  `received_at` = 서버 수신 시각. REPLAY 모드에서는 두 값이 의도적으로 다르다.
- `telemetry_source`: `REPLAY → RECORDED_GPS`, `LIVE → DEVICE_GPS`.
- `ON CONFLICT (recording_session_id, source_timestamp_ns) DO NOTHING` 으로
  릴레이 재시도/WebRTC 재연결 중복을 멱등 처리한다.
- 구현은 다중 행 버전(`telemetry.persistence.ts`)을 `$queryRaw`로 실행한다.

## `getLatestReceivedVehiclePosition.sql`

- 목적: "서버가 **가장 최근에 수신한** 위치". `ORDER BY received_at DESC`.
- `getLatestVehiclePosition.sql`(`recorded_at DESC`)은 원본 시간 기준 의미를 유지한다.
  REPLAY fix는 과거 날짜의 `recorded_at`을 가지므로 "현재 위치" 판단에 사용하면 안 된다.

## 기존 파일 변경

- `getTripPositionTrack.sql`: 원본 시간 순서는 그대로 두고 `received_at`,
  `telemetry_source`, `recording_session_id`, `source_timestamp_ns`,
  `horizontal_accuracy_m` 컬럼을 함께 반환한다.
- `getLatestVehiclePosition.sql`: 의미(원본 시간 기준)는 변경 없음, 주석만 보강.
