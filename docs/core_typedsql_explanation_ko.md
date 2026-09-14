# v15 핵심 Prisma TypedSQL 설명서

> 대상 아키텍처: **v15 차량 지능형 위험 감지 및 경로 관제 시스템**  
> 대상 서비스: **Node/Express Control Backend**  
> DB: **PostgreSQL + PostGIS**  
> ORM/SQL 경계: **Prisma Client + Prisma TypedSQL**  
> 핵심 SQL 수: **10개** (`findNearbyVehicles.sql` 제외)

---

## 1. 문서 목적

이 문서는 v15 Node/Express 백엔드에서 실제 구현 우선순위가 높은 핵심 TypedSQL 파일 10개의 역할과 사용 흐름을 설명한다.

Prisma는 일반적인 scalar/relationship CRUD에는 적합하지만, v16 ERD의 다음 필드는 PostGIS `geography` 타입이므로 일반 Prisma Client만으로 처리하기 어렵다.

- `trip.origin_location`
- `trip.destination_location`
- `vehicle_position.location`
- `route.route_line`
- `route_deviation.location`
- `detection_event.location` — **Node에서는 읽기 전용**

따라서 v15 Node Backend에서는 다음 원칙을 사용한다.

```text
일반 relational CRUD
        ↓
Prisma Client

PostGIS geography 생성/조회/거리 계산
        ↓
Prisma TypedSQL

DB 구조 변경 / PostGIS extension / index
        ↓
Prisma Migration
```

중요한 서비스 소유권 규칙은 다음과 같다.

```text
Node/Express
    - trip write
    - vehicle_position write/read
    - route write/read
    - route_deviation write/read
    - detection_event read

FastAPI Vision
    - frame_inference write
    - detection_event write
    - event_image write
    - vision-origin alert write
```

따라서 **Node의 `prisma/sql/`에 `insertDetectionEvent.sql`을 두지 않는다.**

---

# 2. 핵심 SQL 목록

| 구분 | SQL 파일 | 핵심 역할 |
|---|---|---|
| Trip | `createTrip.sql` | 출발/도착 위치를 PostGIS Point로 변환하여 trip 생성 |
| Trip | `getTripWithLocations.sql` | PostGIS Point를 API용 lat/lng로 변환하여 trip 조회 |
| GPS | `insertVehiclePosition.sql` | GPS longitude/latitude를 geography(Point)로 저장 |
| GPS | `getLatestVehiclePosition.sql` | 차량의 최신 위치 조회 |
| GPS | `getTripPositionTrack.sql` | 시간 범위 기반 실제 주행 궤적 조회 |
| Route | `saveRouteFromGeoJson.sql` | GeoJSON LineString을 `route_line`으로 저장 |
| Deviation | `getCurrentRouteDeviation.sql` | 최신 GPS Point와 현재 Route LineString 사이 거리 계산 |
| Deviation | `insertRouteDeviationIfExceeded.sql` | 임계값 초과 시에만 route_deviation 저장 |
| Deviation | `getRouteDeviations.sql` | 시간 범위 기반 이탈 이벤트 이력 조회 |
| Replay/Vision Read | `getDetectionEventsForReplayWindow.sql` | replay 시간 범위의 detection_event 조회 |

---

# 3. 공통 PostGIS 규칙

## 3.1 좌표 순서

PostGIS `ST_MakePoint`의 v15 입력 규칙은 반드시 다음 순서를 사용한다.

```sql
ST_MakePoint(longitude, latitude)
```

즉:

```text
X = longitude
Y = latitude
```

다음은 틀린 순서다.

```sql
ST_MakePoint(latitude, longitude)
```

---

## 3.2 WGS84 Point 생성

v15의 GPS/출발지/목적지는 WGS84 좌표를 입력으로 받는다.

```sql
ST_SetSRID(
    ST_MakePoint(longitude, latitude),
    4326
)::geography
```

여기서 `ST_SetSRID(..., 4326)`은 좌표계를 **변환하는 함수가 아니다.** 이미 WGS84인 좌표에 SRID 4326을 지정하는 것이다.

---

## 3.3 geography를 API 좌표로 반환

DB 내부에서는 `geography(Point,4326)`을 canonical source로 사용하고 API에서는 숫자 좌표를 반환한다.

```sql
ST_Y(location::geometry) AS lat,
ST_X(location::geometry) AS lng
```

정리하면:

```text
DB
geography(Point,4326)
       ↓
ST_Y / ST_X
       ↓
API
lat / lng
```

---

## 3.4 거리 단위

v15 route deviation에서 사용하는 두 값이 모두 `geography`이므로:

```sql
ST_Distance(point_geography, line_geography)
```

결과는 meter 기준으로 해석한다.

---

# 4. `createTrip.sql`

## 역할

새 운행을 만들 때 일반 문자열/상태 데이터와 함께 출발지 및 목적지 좌표를 PostGIS Point로 생성한다.

`destination_location`은 필수이고 `origin_location`은 선택 가능하다.

## 입력

```text
$1  vehicleId
$2  driverId?
$3  originName?
$4  originAddress?
$5  originLongitude?
$6  originLatitude?
$7  destinationName
$8  destinationAddress?
$9  destinationLongitude
$10 destinationLatitude
$11 plannedStartAt?
```

## 핵심 처리

출발지 좌표는 둘 중 하나라도 없으면 NULL이다.

```sql
CASE
    WHEN $5 IS NULL OR $6 IS NULL THEN NULL
    ELSE ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography
END
```

목적지는 필수이므로 직접 geography Point를 생성한다.

```sql
ST_SetSRID(ST_MakePoint($9, $10), 4326)::geography
```

생성 시 초기 상태는:

```text
READY
```

이다.

## 반환

PostGIS 값을 직접 반환하지 않고 다음과 같은 일반 필드만 반환한다.

```text
tripId
vehicleId
driverId
originName
destinationName
tripStatus
plannedStartAt
createdAt
```

## Repository 사용 위치

```text
TripController
    ↓
TripService.createTrip()
    ↓
TripRepository.create()
    ↓
createTrip.sql
```

## 주의사항

- `vehicleId`, `driverId` 존재 여부 및 상태 검증은 Service 계층에서 먼저 수행하는 것이 좋다.
- `destinationLongitude/Latitude` 범위 검증은 Zod에서 수행한다.
- trip 상태 전이 자체는 SQL 파일이 아니라 Service의 business rule로 관리한다.

---

# 5. `getTripWithLocations.sql`

## 역할

`trip` 테이블의 일반 필드와 함께 PostGIS 출발/도착 위치를 API-friendly 숫자 좌표로 반환한다.

## 입력

```text
$1 tripId
```

## 핵심 처리

```sql
ST_Y(t.origin_location::geometry) AS originLat
ST_X(t.origin_location::geometry) AS originLng

ST_Y(t.destination_location::geometry) AS destinationLat
ST_X(t.destination_location::geometry) AS destinationLng
```

## 사용 이유

Prisma Client로 일반 trip scalar field를 조회할 수 있더라도, PostGIS `geography` 필드를 직접 API DTO로 사용하기 어렵다.

따라서 다음과 같은 화면/API에서 사용한다.

```text
Trip Detail
Map origin marker
Map destination marker
Replay trip metadata
Route planning context
```

## 주의사항

`origin_location`이 nullable이므로 DB/Prisma 생성 타입에서 nullable 결과를 올바르게 처리해야 한다.

---

# 6. `insertVehiclePosition.sql`

## 역할

Android/telemetry endpoint가 전달한 GPS 위치를 `vehicle_position`에 저장한다.

## 입력

```text
$1 vehicleId
$2 tripId?
$3 longitude
$4 latitude
$5 speedKmh?
$6 headingDeg?
$7 recordedAt
```

## 핵심 처리

```sql
ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography
```

GPS 입력의 canonical 위치 저장 방식이다.

## 반환

```text
positionId
```

이 ID는 이후 route deviation 검사에 그대로 사용하는 것이 중요하다.

## 권장 실행 흐름

```text
GPS telemetry request
        ↓
validate vehicle/trip/coordinates
        ↓
insertVehiclePosition.sql
        ↓
positionId
        ↓
route deviation check
```

## 왜 `positionId`가 중요한가

이탈 계산 시 방금 저장한 GPS와 다른 GPS가 섞이는 race를 줄이기 위해 다음 SQL에서 같은 `positionId`를 사용한다.

```text
insertVehiclePosition
        ↓ positionId
insertRouteDeviationIfExceeded
```

---

# 7. `getLatestVehiclePosition.sql`

## 역할

특정 차량의 가장 최신 GPS 위치를 반환한다.

## 입력

```text
$1 vehicleId
```

## 최신 행 결정

```sql
ORDER BY vp.recorded_at DESC,
         vp.position_id DESC
LIMIT 1
```

`recorded_at`이 같은 행이 있을 때 `position_id`를 tie-breaker로 사용하여 결과를 안정적으로 만든다.

## 반환

```text
positionId
vehicleId
tripId
lat
lng
speedKmh
headingDeg
recordedAt
```

## 대표 사용처

```text
Dashboard vehicle marker
Vehicle detail
Current telemetry API
Map refresh
```

---

# 8. `getTripPositionTrack.sql`

## 역할

특정 trip의 실제 이동 경로를 시간순으로 반환한다.

## 입력

```text
$1 tripId
$2 fromTime
$3 toTime
```

## 핵심 설계

전체 trip history를 무조건 반환하지 않는다.

```sql
WHERE vp.trip_id = $1
  AND vp.recorded_at >= $2
  AND vp.recorded_at <= $3
```

v15에서는 `vehicle_position`이 고빈도 테이블이므로 **bounded time-window query**를 기본으로 한다.

## 정렬

```sql
ORDER BY vp.recorded_at ASC,
         vp.position_id ASC
```

Map polyline과 replay timeline은 과거 → 현재 순서가 필요하므로 ascending이다.

## 출력 활용

```text
lat/lng sequence
    ↓
map polyline

speed/heading/recordedAt
    ↓
replay telemetry overlay
```

## 권장 인덱스

```sql
(vehicle_id, recorded_at DESC)
```

뿐만 아니라 실제 trip-window query가 충분히 hot해지면 trip/time index도 workload를 보고 검토할 수 있다.

---

# 9. `saveRouteFromGeoJson.sql`

## 역할

OSRM/A* 등 routing provider가 생성한 경로를 두 가지 표현으로 저장한다.

```text
route_geojson
    → display/cache/API

route_line geography(LineString,4326)
    → ST_Distance 등 spatial computation
```

## 입력

```text
$1 tripId
$2 routeVersion
$3 routeType
$4 distanceM?
$5 durationSec?
$6 encodedPolyline?
$7 routeGeoJson
```

## 핵심 처리

```sql
$7::jsonb
```

으로 표시용 GeoJSON을 저장하고:

```sql
ST_SetSRID(
    ST_GeomFromGeoJSON($7),
    4326
)::geography
```

로 실제 spatial computation용 `route_line`을 만든다.

## 가장 중요한 입력 규칙

`$7`은 **GeoJSON Feature 전체가 아니라 geometry fragment**여야 한다.

올바른 예:

```json
{
  "type": "LineString",
  "coordinates": [
    [129.07, 35.17],
    [129.08, 35.18]
  ]
}
```

잘못된 입력 예:

```json
{
  "type": "Feature",
  "properties": {},
  "geometry": { ... }
}
```

Routing provider가 Feature를 반환하면 Service/adapter에서 `.geometry`만 추출한다.

## Transaction 경계

이 SQL은 새 route 하나를 insert하는 역할만 담당한다.

reroute workflow 전체는 다음처럼 Service에서 관리한다.

```text
old current route = false
        ↓
new route insert
        ↓
new route = current
```

라우팅 provider HTTP 호출 자체를 DB transaction 안에 오래 넣지 않는다.

---

# 10. `getCurrentRouteDeviation.sql`

## 역할

trip의 최신 vehicle position과 현재 route의 LineString 사이 최단 거리를 계산한다.

## 입력

```text
$1 tripId
```

## 핵심 계산

```sql
ST_Distance(vp.location, r.route_line)
```

기존의 "경로 sample point 중 가장 가까운 점" 방식이 아니라 **Point → LineString 거리**를 직접 계산한다.

## 현재 route 선택

```sql
r.trip_id = vp.trip_id
AND r.is_current = TRUE
```

## 최신 위치 선택

```sql
ORDER BY vp.recorded_at DESC,
         vp.position_id DESC
LIMIT 1
```

## 반환

```text
positionId
vehicleId
routeId
deviationDistanceM
recordedAt
```

## 대표 사용처

```text
operator diagnostics
current deviation display
route-control test endpoint
manual inspection
```

이 SQL은 **측정만 수행하고 route_deviation row를 만들지 않는다.**

---

# 11. `insertRouteDeviationIfExceeded.sql`

## 역할

이미 저장된 GPS 위치를 기준으로 정확한 route distance를 계산하고, 임계값을 넘을 때만 `route_deviation`을 생성한다.

## 입력

```text
$1 vehicleId
$2 tripId
$3 routeId
$4 positionId
$5 thresholdMeters
$6 detectedAt
```

## 핵심 구조

### 1단계: measurement

```text
positionId
    +
routeId
    ↓
ST_Distance
```

CTE에서 위치와 route가 실제로 같은 vehicle/trip context인지 검증한다.

```sql
vp.position_id = $4
vp.vehicle_id = $1
vp.trip_id = $2
r.route_id = $3
r.trip_id = $2
```

### 2단계: threshold gate

```sql
WHERE m.deviation_distance_m >= $5
```

### 3단계: 조건 충족 시 INSERT

```text
0 rows returned
    → 정상 주행 / threshold 미초과

1 row returned
    → route_deviation 생성
```

## 왜 이 방식이 중요한가

Application이 다음처럼 따로 처리하면 race window가 생길 수 있다.

```text
SELECT current distance
        ↓
새 GPS INSERT
        ↓
INSERT route_deviation
```

현재 구현은 이미 저장된 `positionId`와 검사 대상 `routeId`를 명시적으로 전달하여 어떤 위치/경로를 검사했는지 고정한다.

## 이후 Service workflow

```text
route_deviation inserted
        ↓
Node creates ROUTE_DEVIATION alert
        ↓
routing provider call
        ↓
new route save
        ↓
route_deviation.recalculated_route_id update
```

---

# 12. `getRouteDeviations.sql`

## 역할

특정 trip의 route deviation history를 bounded time window로 조회한다.

## 입력

```text
$1 tripId
$2 fromTime
$3 toTime
```

## 반환

```text
deviationId
vehicleId
tripId
routeId
deviationDistanceM
lat
lng
detectedAt
resolvedAt
recalculatedRouteId
createdAt
```

## 사용처

```text
trip history
map deviation markers
replay timeline
route-control diagnostics
statistics
```

## 중요 설계

`location geography`를 그대로 반환하지 않고 SQL 안에서 `lat/lng`로 변환한다.

---

# 13. `getDetectionEventsForReplayWindow.sql`

## 역할

FastAPI Vision이 저장한 `detection_event`를 Node의 replay/history API가 읽기 위해 사용한다.

이 SQL은 **Node read-side 전용**이다.

## 서비스 소유권

```text
FastAPI Vision
    INSERT detection_event

Node/Express
    SELECT detection_event
```

## 입력

```text
$1 tripId
$2 fromCaptureTimestampNs
$3 toCaptureTimestampNs
```

## 왜 DateTime이 아니라 `capture_timestamp_ns`인가

v15 replay의 source timeline은 CameraX가 만든:

```text
capture_timestamp_ns
```

이다.

실제 replay alignment는:

```text
detection_event.capture_timestamp_ns
           ↓
video_time_anchor
           ↓
video_pts_us
           ↓
H.264 seek/render
```

형태다.

다음은 sync key로 사용하지 않는다.

```text
network arrival time
DB created_at
frame_id / fps 근사
```

## location nullable 처리

`detection_event.location`은 nullable이므로:

```sql
CASE
    WHEN de.location IS NULL THEN NULL
    ELSE ST_Y(de.location::geometry)
END
```

패턴을 사용한다.

## 주요 반환값

### Frame identity

```text
sessionId
frameId
captureTimestampNs
```

### AI metadata

```text
modelVersion
classId
trackId
className
displayName
confidence
distanceM
warningDistanceM
riskLevel
```

### Rendering

```text
bboxX1
bboxY1
bboxX2
bboxY2
```

### Audit / distance context

```text
pitchAtCaptureDeg
rollAtCaptureDeg
telemetrySource
```

## 정렬

```sql
ORDER BY
    capture_timestamp_ns,
    frame_id,
    detection_event_id
```

Replay timeline을 deterministic하게 유지한다.

---

# 14. 핵심 호출 흐름

## 14.1 GPS → route deviation

```text
Android GPS
    ↓
Node Telemetry API
    ↓
insertVehiclePosition.sql
    ↓
positionId
    ↓
getCurrentRouteDeviation.sql        # optional inspection
    ↓
insertRouteDeviationIfExceeded.sql  # authoritative gate + persistence
    ↓
0 row ──────────────► continue
1 row
    ↓
alert
    ↓
reroute
    ↓
saveRouteFromGeoJson.sql
```

---

## 14.2 Trip map/history

```text
Trip Detail
    ├─ getTripWithLocations.sql
    ├─ getTripPositionTrack.sql
    └─ getRouteDeviations.sql
```

---

## 14.3 Replay

```text
ReplayService
    ├─ Prisma: trip_video
    ├─ Prisma: video_time_anchor
    ├─ Prisma/appropriate read: frame_inference
    ├─ TypedSQL: getDetectionEventsForReplayWindow.sql
    └─ TypedSQL: getTripPositionTrack.sql
```

Replay를 하나의 거대한 SQL 파일로 만들기보다 Service 계층에서 각 repository 결과를 합성하는 편이 v15의 ownership/boundary와 잘 맞는다.

---

# 15. Repository 권장 매핑

```text
TripRepository
    createTrip.sql
    getTripWithLocations.sql

VehiclePositionRepository
    insertVehiclePosition.sql
    getLatestVehiclePosition.sql
    getTripPositionTrack.sql

RouteRepository
    saveRouteFromGeoJson.sql

RouteDeviationRepository
    getCurrentRouteDeviation.sql
    insertRouteDeviationIfExceeded.sql
    getRouteDeviations.sql

DetectionEventRepository
    getDetectionEventsForReplayWindow.sql
```

Service code에는 가급적 다음 PostGIS 함수명이 직접 노출되지 않도록 한다.

```text
ST_MakePoint
ST_X
ST_Y
ST_Distance
ST_GeomFromGeoJSON
```

Service는 business language를 사용한다.

```text
position
route
deviation
replay window
detection event
```

---

# 16. 테스트 체크리스트

## PostGIS Integration Test

- [ ] `ST_MakePoint(longitude, latitude)` 좌표 순서 확인
- [ ] geography 저장 후 `ST_X/ST_Y` 원복 값 확인
- [ ] route LineString 생성 확인
- [ ] Point → LineString `ST_Distance`가 meter 단위인지 확인
- [ ] threshold 미만이면 `insertRouteDeviationIfExceeded.sql`이 0 row 반환
- [ ] threshold 이상이면 정확히 1 row 생성
- [ ] nullable `detection_event.location` 처리 확인
- [ ] replay query가 `capture_timestamp_ns` 범위를 정확히 포함
- [ ] 같은 timestamp가 있을 때 ordering이 deterministic한지 확인
- [ ] long trip query가 반드시 time window를 사용하도록 API 수준에서 제한

## Transaction Test

- [ ] reroute 시 current route가 2개가 되지 않는지 확인
- [ ] deviation 생성 후 alert 생성 failure 정책 확인
- [ ] routing provider 호출을 장시간 DB transaction 안에 두지 않는지 확인

---

# 17. 최종 요약

v15 핵심 TypedSQL 10개는 크게 네 종류다.

```text
1. PostGIS Point 생성
   createTrip
   insertVehiclePosition

2. PostGIS Point 추출
   getTripWithLocations
   getLatestVehiclePosition
   getTripPositionTrack
   getRouteDeviations
   getDetectionEventsForReplayWindow

3. PostGIS LineString 생성
   saveRouteFromGeoJson

4. Spatial distance
   getCurrentRouteDeviation
   insertRouteDeviationIfExceeded
```

가장 중요한 구현 원칙은 다음 세 가지다.

1. **PostGIS geography가 위치 데이터의 canonical source다.**
2. **Node는 control/business spatial data를 TypedSQL로 처리하고, FastAPI Vision의 detection write path를 가져오지 않는다.**
3. **history/replay 쿼리는 전체 데이터를 무제한 반환하지 않고 bounded window를 사용한다.**
