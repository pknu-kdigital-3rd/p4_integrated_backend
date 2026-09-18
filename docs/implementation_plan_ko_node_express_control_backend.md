> 이전 v15 계획 문서입니다. 현재 통합 스키마와 구조는 `v18_its_integrated_erd.md` 및 루트 `README.md`를 참조하십시오.

# Node / Express Control & Business Backend
## 상세 구현 계획 — v15 아키텍처 기준

**역할:** 차량 지능형 위험 감지 및 경로 관제 플랫폼의 Control / Business Plane authority
**주요 책임:** 인증, RBAC, bootstrap/service discovery, 차량/운전자/운행/GPS/경로/이탈/알림/통계/history/replay metadata, Prisma migration
**담당하지 않는 역할:** 실제 Vision gRPC endpoint, GPU inference, Android→Tauri live frame relay
**주요 기술 스택:** TypeScript + Node.js + Express 5 + Prisma 7 + PostgreSQL/PostGIS + TypedSQL + Zod/OpenAPI

---

# 1. 서비스 목표

Node/Express Backend는 프로젝트의 일반 업무 및 관제 상태를 소유하는 application authority다. FastAPI Vision Service가 고빈도 AI inference에 집중하는 동안, Node는 시스템의 장기적인 업무 상태와 사용자 권한, 차량 운행 상태, 공간 경로, 경로 이탈, 알림, 녹화/replay metadata, 통계 API를 책임진다.

Node의 목적은 모든 트래픽을 한 곳으로 모으는 것이 아니다. 오히려 v15에서는 다음을 명확히 분리한다.

- live media traffic은 Node를 통과하지 않는다.
- vision inference traffic도 Node를 통과하지 않는다.
- Node는 그 대신 인증과 service discovery를 통해 client가 올바른 endpoint를 찾도록 한다.
- Node는 Tauri가 조회하는 business/history/replay의 유일한 public backend다.
- Node는 DB schema migration의 단일 authority다.

Node가 반환하는 것은 **Vision Service Address**이며, 실제 Vision gRPC server는 FastAPI가 소유한다.

---

# 2. 책임 경계

## 2.1 Node/Express가 소유하는 것

- `system_user` 기반 operator authentication.
- password lifecycle.
- RBAC.
- JWT/access token 발급.
- Android/Tauri bootstrap.
- service discovery.
- vehicle CRUD.
- camera calibration configuration.
- driver CRUD.
- trip lifecycle.
- GPS telemetry ingestion.
- `vehicle_position` history.
- route creation/versioning/current route.
- route deviation calculation.
- rerouting coordination.
- object class/display/warning threshold policy.
- alert read/update/acknowledge/operator note.
- route-deviation-origin alert.
- trip-completed alert.
- `trip_video` metadata.
- `video_time_anchor` persistence/read.
- replay window API.
- history/statistics/dashboard business API.
- Object Storage upload/download authorization.
- transport goal/statistics.
- Prisma schema + migrations.
- FastAPI에 제공하는 low-rate internal Vision context API.

## 2.2 Node/Express가 소유하지 않는 것

- 실제 Vision gRPC endpoint.
- GPU model lifecycle.
- inference preprocessing/postprocessing.
- live detection stream generation.
- `frame_inference` write.
- vision-origin `detection_event` write.
- event snapshot 생성.
- Android→Tauri direct frame relay.
- Tauri의 frame/detection exact join.

Node는 Vision service의 routing information을 제공하지만 Vision transport를 proxy하지 않는다.

---

# 3. 기술 기준

권장 baseline:

- Node.js 24.x 계열 또는 Prisma 7 지원 범위의 Node 22.12+.
- TypeScript.
- Express 5.
- Prisma ORM 7.
- `@prisma/adapter-pg` + `pg`.
- PostgreSQL + PostGIS.
- Prisma TypedSQL.
- Zod 4.
- Zod → OpenAPI.
- Swagger UI `/docs`.
- ReDoc `/redoc`.
- Pino/Pino HTTP.
- `ws` 또는 필요 시 별도 realtime adapter.
- Vitest + Supertest.
- Docker Compose 기반 local integration environment.

중요 원칙:

- Prisma Client는 일반 scalar CRUD에 사용.
- PostGIS geography/geometry 연산은 TypedSQL 또는 explicit parameterized SQL 사용.
- raw SQL string interpolation 금지.
- runtime validation과 API documentation은 동일한 Zod schema를 사용.

---

# 4. Layered Architecture

권장 계층:

```text
HTTP Request
   ↓
Express Router
   ↓
Authentication / RBAC Middleware
   ↓
Zod Request Validation
   ↓
Controller
   ↓
Application Service
   ↓
Repository / Integration Adapter
   ├── Prisma Client
   ├── TypedSQL / PostGIS
   ├── Object Storage
   ├── Routing Provider (OSRM/A*)
   └── Internal/External Service Client
   ↓
Response Mapper + Zod Response Validation
```

### 계층 책임

**Router**
- URL/method 연결.
- middleware composition.

**Controller**
- HTTP transport만 처리.
- request→service input 변환.
- status/response mapping.

**Service**
- business rule.
- transaction boundary.
- 여러 repository/integration orchestration.

**Repository**
- DB access.
- Prisma/TypedSQL 세부 구현 숨김.

**Integration Adapter**
- OSRM/A*.
- Object Storage.
- optional LLM.

---

# 5. 권장 Repository 구조

```text
backend-control-node/
├── package.json
├── tsconfig.json
├── prisma.config.ts
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   ├── seed.ts
│   └── sql/
│       ├── insertVehiclePosition.sql
│       ├── getLatestVehiclePosition.sql
│       ├── getTripPositionTrack.sql
│       ├── createTrip.sql
│       ├── saveRouteFromGeoJson.sql
│       ├── insertRouteDeviationIfExceeded.sql
│       ├── getRouteDeviations.sql
│       └── replayWindow.sql
├── src/
│   ├── app.ts
│   ├── server.ts
│   ├── config/
│   ├── common/
│   │   ├── errors/
│   │   ├── middleware/
│   │   ├── validation/
│   │   ├── logging/
│   │   └── openapi/
│   ├── auth/
│   ├── bootstrap/
│   ├── vehicles/
│   ├── drivers/
│   ├── trips/
│   ├── telemetry/
│   ├── routes/
│   ├── deviations/
│   ├── alerts/
│   ├── object-classes/
│   ├── replay/
│   ├── statistics/
│   ├── transport-goals/
│   ├── internal/
│   │   └── vision-context/
│   └── integrations/
│       ├── routing/
│       ├── object-storage/
│       └── llm/
├── tests/
│   ├── unit/
│   ├── api/
│   ├── integration/
│   └── contract/
└── deploy/
```

모듈별로 `*.router.ts`, `*.controller.ts`, `*.service.ts`, `*.repository.ts`, `*.schema.ts` 같은 일관된 형태를 사용한다.

---

# 6. DB 소유권 및 Access Strategy

## 6.1 Schema Authority

shared PostgreSQL schema의 migration authority는 **Prisma Migrate 하나만** 유지한다.

- Node repository가 `schema.prisma`를 소유.
- FastAPI는 자체 migration을 실행하지 않음.
- CI에서 Prisma migration을 빈 DB에 적용.
- 이후 FastAPI writer integration test를 같은 DB에 수행하여 drift를 탐지.

이렇게 해야 Node와 FastAPI가 같은 DB를 쓰더라도 schema source of truth가 둘로 갈라지지 않는다.

## 6.2 Prisma Client vs TypedSQL

### Prisma Client에 적합

- `system_user`.
- `vehicle`의 일반 scalar field.
- `driver`.
- `trip_video` metadata.
- `object_class` 관리.
- `alert` 일반 update/read.
- 비GIS 통계/업무 CRUD.

### TypedSQL/PostGIS가 필요한 영역

- `vehicle_position.location` write/read.
- `trip.origin_location`, `destination_location`.
- `route.route_line`.
- `route_deviation.location`.
- `detection_event.location` read.
- `transport_goal.destination_location`.
- `ST_Distance`.
- `ST_DWithin`.
- `ST_X`/`ST_Y`.
- `ST_AsGeoJSON`.

위치 데이터의 source of truth는 `latitude/longitude` 쌍이 아니라 PostGIS `geography(Point,4326)`다.

### Parameterized SQL 원칙

좋은 예:

```sql
WHERE vehicle_id = $1
```

나쁜 예:

```ts
const sql = `SELECT ... WHERE vehicle_id = ${input}`;
```

---

# 7. Module Plan

# 7.1 Authentication / RBAC

## 목표

- operator credential 검증.
- access token 발급.
- 역할별 권한 적용.
- FastAPI가 검증할 수 있는 JWT 발급.

### 권장 흐름

```text
POST /auth/login
   ↓
Zod validation
   ↓
user lookup
   ↓
password verify
   ↓
status/role check
   ↓
JWT issue
   ↓
bootstrap/service descriptor 포함 가능
```

### Password

- Argon2id 또는 적절한 password hashing.
- plaintext 저장 금지.
- login failure에 민감정보 log 금지.
- brute-force/rate-limit 정책 고려.

### JWT

권장 claim:

- `sub`.
- `iss`.
- `aud`.
- `exp`.
- role/scope.
- token version 필요 시 포함.

**Vision endpoint 주소를 JWT claim에 고정하지 않는다.** 주소는 bootstrap/service descriptor에서 반환한다.

### Middleware Chain

```text
request id
→ logging
→ CORS/security headers
→ auth
→ RBAC
→ validation
→ controller
→ error middleware
```

### FastAPI 관계

- Node가 JWT sign.
- FastAPI는 public key/JWKS로 local verify.
- inference마다 Node로 validation round-trip하지 않음.

---

# 7.2 Bootstrap / Service Discovery

Android와 Tauri가 runtime endpoint를 찾도록 하는 control-plane API다.

예시:

```text
GET /bootstrap
POST /device/bootstrap
```

응답 개념:

```json
{
  "token": "...",
  "services": {
    "visionGrpcAddress": "vision.example.internal:50051",
    "controlApiBaseUrl": "https://api.example.com",
    "dashboardAddress": "..."
  },
  "storage": {
    "upload": {}
  }
}
```

명확한 용어:

- Node가 반환하는 것은 `Vision Service Address` 또는 endpoint descriptor.
- FastAPI가 실제 Vision gRPC endpoint를 소유.

endpoint 변경이 user identity보다 자주 발생할 수 있으므로 routing을 token identity와 분리한다.

---

# 7.3 Vehicle Module

책임:

- vehicle CRUD.
- vehicle code/status.
- camera calibration configuration.
- active/inactive state.
- Vision context에서 필요한 calibration 제공.

calibration 변경 시:

- version 또는 `updated_at` 변경.
- FastAPI cache refresh가 이를 감지 가능하게 함.

validation:

- camera height > 0.
- pitch/roll/yaw range.
- optional intrinsic values sanity.

---

# 7.4 Driver Module

- driver CRUD.
- status 관리.
- trip relation.
- 개인정보/API exposure 최소화.

운행 생성 시 driver/vehicle 상태를 함께 검증한다.

---

# 7.5 Trip Module

책임:

- 운행 생성.
- 시작/종료.
- active trip 조회.
- origin/destination location.
- AI summary metadata.

### 상태 전이

예:

```text
PLANNED
  ↓ start
IN_PROGRESS
  ↓ complete
COMPLETED
```

필요 시 `CANCELLED` 등 추가.

service layer에서 허용되지 않는 상태 전이를 차단한다.

### FastAPI Context

FastAPI는 vehicle별 active `trip_id`를 필요로 한다. Node internal Vision context에 포함하고 FastAPI가 cache한다.

---

# 7.6 Telemetry / Vehicle Position Module

Android가 GPS telemetry를 보내는 endpoint.

입력 예:

- vehicleId.
- tripId.
- longitude.
- latitude.
- speed.
- heading.
- recordedAt.

DB 저장:

```sql
ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
```

주의: `ST_MakePoint` 인자 순서는 longitude, latitude다.

### 필수 Query

- insert vehicle position.
- latest position by vehicle.
- trip position track by time window.

### 성능

인덱스:

```sql
CREATE INDEX idx_vehicle_position_vehicle_time
ON vehicle_position(vehicle_id, recorded_at DESC);
```

long trip 전체 데이터를 항상 반환하지 않고 `fromTime/toTime` bounded query를 기본으로 한다.

---

# 7.7 Route Module

route는 trip 내에서 versioned entity다.

보존 내용:

- route_version.
- route_type.
- distance_m.
- duration_sec.
- encoded_polyline.
- route_geojson.
- `route_line geography(LineString,4326)`.
- `is_current`.

### 새 Route 저장

routing provider가 GeoJSON Feature를 반환하면 PostGIS에는 `geometry` 부분을 사용한다.

```sql
ST_SetSRID(ST_GeomFromGeoJSON($geojson), 4326)::geography
```

`ST_SetSRID`는 좌표 변환이 아니라 이미 WGS84인 좌표에 SRID metadata를 부여하는 것이다.

### Current Route 변경

새 reroute 저장 시 transaction 안에서:

1. 기존 route `is_current = false`.
2. 새 route insert.
3. 새 route `is_current = true`.

trip에 current route가 여러 개 생기지 않도록 DB/application invariant를 둔다.

---

# 7.8 Route Deviation Module

현재 차량 point와 현재 route line 간 최단 거리를 PostGIS로 계산한다.

```text
vehicle_position.location
        +
route.route_line
        ↓
ST_Distance
        ↓
threshold 비교
        ↓
정상 / route_deviation 생성
```

`geography`를 사용하면 distance가 meter 단위로 계산되므로 업무 threshold와 직접 비교 가능하다.

대표 TypedSQL:

```text
insertRouteDeviationIfExceeded
getRouteDeviations
```

### 흐름

1. telemetry 저장.
2. current route 조회.
3. spatial distance 계산.
4. threshold 미만 → 종료.
5. threshold 이상 → `route_deviation` INSERT.
6. route-deviation-origin alert 생성.
7. rerouting orchestration.
8. 새 route version 저장.

### Duplicate Suppression

GPS가 빈번하게 들어오면 같은 이탈 상태에서 alert가 과도하게 생성될 수 있다.

정책 예:

- 최근 N초 내 같은 trip/route deviation 존재 여부.
- deviation episode 개념.
- 이전 alert가 active면 중복 alert 억제.

정확한 rule은 product requirement로 고정하되, 매 GPS row마다 alert를 무조건 생성하지 않는다.

---

# 7.9 Routing Integration

OSRM/A* 등 routing provider를 interface로 감싼다.

```ts
interface RoutingProvider {
  buildRoute(input: RouteRequest): Promise<RouteCandidate>;
}
```

service layer는 특정 provider HTTP schema에 직접 의존하지 않는다.

필수 처리:

- timeout.
- retry 제한.
- malformed route response.
- no-route case.
- provider latency metric.

routing 실패는 기존 current route를 자동 삭제하지 않는다.

---

# 7.10 Object Class Policy Module

Node가 소유하는 정책 데이터:

- class_name.
- display_name.
- warning_distance_m.
- enabled/disabled.
- 필요 시 severity/risk policy.

FastAPI가 사용하는 값이므로:

- policy version/updated_at 제공.
- internal Vision context에 포함.
- update 시 cache refresh 가능.

`detection_event`에는 당시 display/threshold snapshot을 비정규화하여 향후 policy 변경 후에도 과거 event를 설명할 수 있게 한다.

---

# 7.11 Alert Module

alert 발생 원인에 따라 write owner가 다르다.

- vision detection 기반: FastAPI INSERT.
- route deviation 기반: Node INSERT.
- trip completed: Node INSERT.

Node는 이후 모든 alert의 read/update/acknowledge를 담당한다.

기능:

- alert list.
- filters.
- acknowledge.
- operator note.
- status change.
- event/deviation/trip detail 연결.

### 권한

acknowledge/operator note는 operator role에 따라 제한한다.

### 감사성

`acknowledged_by`, `acknowledged_at`, `operator_note` 등을 변경할 때 필요한 audit log 정책을 고려한다.

---

# 7.12 Vision Record Read Model

FastAPI가 write한 데이터를 Tauri가 직접 DB에서 읽지 않는다. Node가 read API를 제공한다.

대상:

- `frame_inference`.
- `detection_event`.
- `event_image`.
- vision-origin `alert`.

API는 replay/history 목적의 bounded query를 제공한다.

예:

```text
GET /trips/{tripId}/detections?from=...&to=...
GET /trips/{tripId}/events?from=...&to=...
GET /events/{eventId}
```

PostGIS location은 조회 시 `ST_X/ST_Y` 또는 GeoJSON으로 변환한다.

---

# 7.13 Video Metadata / Replay

## Recording Metadata

Android H.264 segment upload 이후 Node가 `trip_video` metadata를 등록한다.

보존 항목 개념:

- trip id.
- object key/path.
- segment/file sequence.
- start/end time.
- start frame id diagnostic.
- fps diagnostic.
- duration/codec metadata.

## Time Anchor

Android encoder가 생성한:

```text
capture_timestamp_ns ↔ video_pts_us
```

mapping을 `video_time_anchor`에 저장한다.

실제 replay alignment의 source of truth다.

`frame_id / fps` 계산을 synchronization 기준으로 사용하지 않는다.

## Replay API

Tauri는 replay를 위해 Node에 bounded window를 요청한다.

예:

```text
GET /trips/{tripId}/replay?from=...&to=...
```

응답 개념:

- trip/video metadata.
- presigned media URL 또는 segment list.
- time anchors.
- GPS track.
- detection events.
- frame inference 필요 범위.
- event markers.

대규모 trip은 pagination/time-window로 나눈다.

---

# 7.14 Transport Goal / Statistics

`transport_goal`은 full dispatch optimizer가 아니라 통계/진척도용 최소 entity다.

지원 예:

- 전체 목표 수.
- 완료 수.
- 진행 중.
- delayed/expected delay.
- vehicle별 목표.
- completion rate.

복잡한 dispatch planning table을 baseline에 추가하지 않는다.

---

# 7.15 선택 기능: Trip AI Summary

trip 완료 후 구조화된 데이터를 LLM에 전달하여 `trip.ai_summary`를 생성할 수 있다.

입력:

- duration/distance.
- route deviations.
- alerts.
- significant vision events.
- transport goal 결과.

원칙:

- summary는 derived artifact.
- DB structured records가 source of truth.
- LLM failure가 trip completion을 실패시키지 않음.
- timeout/retry bounded.

---

# 8. Internal Vision Context API

FastAPI가 저빈도로 조회하는 내부 API.

```text
GET /internal/vehicles/{vehicleId}/vision-context
```

응답 예:

```json
{
  "vehicleId": 12,
  "activeTripId": 991,
  "calibrationVersion": 4,
  "policyVersion": 7,
  "calibration": {},
  "objectClassPolicies": []
}
```

### 보안

- public API와 분리.
- internal service audience/scope.
- network allow-list/mTLS 등 고려.
- 일반 operator token으로 불필요하게 접근하지 못하게 함.

### 성능

- frame당 호출하지 않음.
- Node API는 cache-friendly한 version metadata 제공.
- calibration/policy update가 자주 없는 특성을 활용.

---

# 9. Public API Design

## 9.1 Versioning

```text
/api/v1/...
```

breaking change는 명시적으로 version bump.

## 9.2 Error Envelope

일관된 형태 예:

```json
{
  "error": {
    "code": "ROUTE_NOT_FOUND",
    "message": "...",
    "requestId": "...",
    "details": {}
  }
}
```

DB raw error/stack trace를 client에 노출하지 않는다.

## 9.3 Validation

Zod schema를 다음에 공동 사용:

- request validation.
- response validation.
- OpenAPI generation.
- internal type inference.

FastAPI/Pydantic과 protobuf contract 사이에서 이름/단위가 다르면 별도 contract 문서로 명시한다.

---

# 10. Object Storage Authorization

Node는 H.264/image byte를 relay하지 않는 것을 기본으로 한다.

## Upload

Android에 scoped upload credential/presigned URL 발급.

제약:

- 특정 bucket/prefix.
- object size/type 제한.
- 짧은 expiry.
- vehicle/trip과 연결된 object key.

## Replay

Tauri에 짧은 expiry의 Range GET 가능한 presigned URL 반환.

Node는 권한을 확인한 뒤 URL을 발급한다.

이렇게 하면 replay media byte가 Node process를 통과하지 않는다.

---

# 11. Security

## 11.1 Password

- 강한 password hashing.
- plaintext 금지.
- credential log 금지.
- login rate limiting.

## 11.2 JWT

- asymmetric signing 권장.
- issuer/audience/expiry.
- 최소 scope.
- key rotation 전략.
- refresh token 도입 시 별도 lifecycle 설계.

## 11.3 RBAC

예시 role:

- ADMIN.
- OPERATOR.
- VIEWER.

API별 permission matrix를 문서화한다.

## 11.4 SQL

- parameterized query only.
- `$queryRawUnsafe` 최소화/원칙적 금지.
- dynamic identifier가 필요하면 allow-list.

## 11.5 Internal Endpoint

FastAPI internal context API는 일반 public route보다 더 제한한다.

---

# 12. Transaction / Consistency

transaction이 필요한 대표 workflow:

### Reroute

```text
route_deviation insert
→ alert insert
→ routing candidate 확보
→ old route is_current=false
→ new route insert/current=true
```

routing provider 호출 자체를 DB transaction 안에서 오래 유지하지 않는다.

권장 방식:

1. deviation/alert commit.
2. external routing call.
3. 새 route를 짧은 transaction으로 적용.

### Trip Complete

- trip status update.
- destination/end metadata.
- trip-completed alert.
- optional summary job trigger.

### Alert Acknowledge

- current status check.
- acknowledged_by/time update.
- idempotent behavior.

---

# 13. Realtime Business Update

Tauri business view에 WebSocket/SSE를 추가할 수 있다.

대상:

- new alert.
- route changed.
- vehicle status changed.
- trip completed.

단, 이것은 **live frame transport가 아니다**.

```text
Business event WebSocket ≠ Android→Tauri live frame gRPC
```

두 경로를 혼동하지 않는다.

---

# 14. Observability

## 14.1 Logging

structured log 필드:

- request_id.
- user_id.
- vehicle_id.
- trip_id.
- route_id.
- event_id.
- alert_id.
- operation.
- duration_ms.

password/token 전체 값은 log 금지.

## 14.2 Metrics

예:

```text
http_request_duration_ms
http_requests_total
http_errors_total
auth_failures_total
telemetry_writes_total
telemetry_write_latency_ms
route_deviation_query_latency_ms
reroute_provider_latency_ms
replay_query_latency_ms
presigned_url_issued_total
active_trips
active_vehicles
unacknowledged_alerts
```

## 14.3 DB Query Diagnostics

느린 query 분석에 필요한 metadata:

- operation/query name.
- vehicleId.
- tripId.
- routeId.
- time window.
- row count.
- duration.

SQL 전체와 민감 parameter를 무조건 log하지 않는다.

---

# 15. 테스트 전략

## 15.1 Unit Test

- auth service.
- RBAC.
- trip state transition.
- route deviation threshold rule.
- alert state update.
- replay window mapping.
- Zod validation.

## 15.2 API Test

Supertest 등으로:

- auth success/failure.
- RBAC.
- CRUD status code.
- validation error.
- error envelope.
- pagination/time-window.

## 15.3 PostGIS Integration Test

실제 PostgreSQL/PostGIS에서:

- `ST_MakePoint` write.
- `ST_X/ST_Y` read.
- route LineString.
- `ST_Distance` deviation.
- geography units meter.
- GiST index query plan 필요 시 확인.

SQLite/mock DB로 GIS 동작을 대신하지 않는다.

## 15.4 Migration Test

CI:

1. empty PostgreSQL.
2. PostGIS extension.
3. `prisma migrate deploy`.
4. schema validation.
5. Node integration test.
6. FastAPI writer compatibility test.

## 15.5 Cross-Service Contract Test

- Node-issued JWT → FastAPI verify.
- bootstrap `Vision Service Address` schema.
- Vision context API schema.
- Prisma schema ↔ FastAPI writer.
- replay fields ↔ Tauri contract.

---

# 16. 성능 및 데이터량 전략

## Vehicle Position

고빈도 row이므로:

- `(vehicle_id, recorded_at DESC)` index.
- trip/time window query.
- pagination/bounded history.
- 필요한 column만 SELECT.

## Frame Inference

Node는 read side다.

- trip/capture time index 활용.
- replay window에 필요한 범위만 조회.
- 큰 JSONB를 모든 dashboard query에서 가져오지 않음.

## Detection Event

이벤트는 raw frame보다 적지만 장기 보관/통계에 사용된다.

- trip/time index.
- severity/class filters.
- spatial query 필요 시 GiST.

## Replay

매번 전체 trip history를 반환하지 않는다.

요청:

```text
tripId + fromTime + toTime
```

을 기본으로 한다.

## Database Pooling

Node와 FastAPI가 같은 PostgreSQL을 사용하므로 connection pool 합산을 고려한다.

- Node pool.
- FastAPI writer pool.
- migration/admin connection.

DB `max_connections`를 각 서비스 기본값 합계보다 여유 있게 설계하되 무작정 크게 설정하지 않는다.

---

# 17. 장애 처리

## Routing Provider 장애

- 기존 current route 유지.
- deviation/alert는 보존.
- reroute 실패 상태 기록.
- bounded retry 또는 operator-visible error.

## PostgreSQL 장애

- Node business writes 실패를 명확히 반환.
- request-level retry는 idempotency 고려.
- 무한 retry 금지.
- health/readiness 정책 분리.

## Object Storage 장애

- presigned URL 발급 실패를 명시.
- DB metadata와 object 존재 불일치 탐지 도구 필요.

## FastAPI Vision 장애

- Node 자체 business 기능은 계속 가능.
- bootstrap/status에서 Vision unavailable 표시 가능.
- Node가 Vision inference를 대신하지 않는다.

## LLM Summary 장애

- trip completion은 성공해야 함.
- summary status만 failed/pending.
- 재시도는 background/bounded.

---

# 18. 구현 단계

## Stage N0 — Project Foundation

- Node/TS/Express setup.
- layered structure.
- Zod/OpenAPI.
- Swagger/ReDoc.
- logging/error handling.
- Docker Compose.

## Stage N1 — Prisma v15 Schema

- 15 tables.
- PostGIS extension.
- `Unsupported("geography...")` 또는 프로젝트 기준 mapping.
- migrations.
- seed/reference data.
- indexes/check constraints.

완료 기준: 빈 DB에서 migration 재현 가능.

## Stage N2 — Auth / RBAC / Bootstrap

- system_user auth.
- password hashing.
- JWT.
- RBAC middleware.
- service descriptor.
- Vision Service Address.

완료 기준: Android/Tauri/FastAPI credential contract 검증.

## Stage N3 — Core Business Entity

- vehicle.
- calibration.
- driver.
- trip.
- object class.
- alert basic read/update.

## Stage N4 — GPS / PostGIS

- telemetry ingestion.
- position TypedSQL.
- latest position.
- trip track.
- spatial serialization.

## Stage N5 — Route / Deviation

- routing adapter.
- route save/version.
- current route invariant.
- deviation query.
- alert.
- reroute workflow.

## Stage N6 — Vision Integration Read Side

- internal Vision context API.
- `frame_inference` read.
- detection event history.
- event image metadata.
- vision alert integration.

## Stage N7 — Recording Metadata

- trip video registration.
- time anchor insert.
- object key validation.
- upload authorization.

## Stage N8 — Replay API

- bounded replay window.
- presigned Range GET.
- GPS/event/frame metadata aggregation.
- Tauri contract.

## Stage N9 — Dashboard / Statistics

- active vehicles/trips.
- latest positions.
- routes.
- alerts.
- transport goal progress.
- event statistics.

## Stage N10 — Hardening

- rate limiting.
- security headers.
- key rotation.
- DB slow query review.
- load tests.
- backup/restore.
- failure drills.

## Stage N11 — 선택 기능

- trip AI summary.
- advanced heatmap.
- nearby event/vehicle spatial API.
- richer realtime business notification.

---

# 19. Node/Express Definition of Done

Node/Express Backend는 다음을 모두 만족할 때 기준선 구현이 완료된 것으로 본다.

1. operator auth/RBAC/JWT를 소유한다.
2. bootstrap에서 Vision Service Address를 반환하지만 Vision gRPC endpoint를 호스팅하지 않는다.
3. v15의 15-table schema를 Prisma Migrate로 재현 가능하게 관리한다.
4. PostGIS 위치가 canonical source이고 latitude/longitude 이중 저장을 하지 않는다.
5. Prisma Client와 TypedSQL 경계가 일관되다.
6. vehicle/driver/trip/GPS/route/deviation/alert 기본 workflow가 동작한다.
7. route deviation은 `ST_Distance` 기반 spatial calculation을 사용한다.
8. reroute가 route version/current invariant를 깨지 않는다.
9. FastAPI가 필요한 calibration/policy/active trip context를 internal API로 제공한다.
10. FastAPI가 write한 vision record를 Node API로 history/replay에서 조회할 수 있다.
11. `trip_video`/`video_time_anchor` 기반 replay metadata를 제공한다.
12. Tauri에 presigned media access를 제공하며 media byte를 Node가 relay하지 않는다.
13. Tauri나 Android에 DB credential을 노출하지 않는다.
14. OpenAPI와 runtime Zod validation이 같은 schema를 기반으로 한다.
15. integration test가 실제 PostgreSQL/PostGIS에서 실행된다.
16. FastAPI writer와 Prisma schema drift를 CI에서 탐지한다.
17. 주요 business/history/replay query가 bounded time-window와 적절한 index를 사용한다.
18. 장애 상황에서 Node가 Vision 또는 Object Storage 역할을 임의로 대신하지 않고 명확한 degraded state를 제공한다.

