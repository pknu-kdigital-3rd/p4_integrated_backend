# 차량 지능형 위험 감지 및 경로 관제 시스템 ERD 설계 (v16)

> **문서 상태:** v16 구현 기준선 (Implementation Baseline)  
> **범위:** 전체 프로젝트의 영속 데이터 모델, 서비스별 쓰기/읽기 소유권, PostGIS 경계, 실시간 비전 프레임 동기화, 영상 재생 동기화  
> **아키텍처 기준:** Media Plane / Vision Plane / Control-Business Plane  
> **중요 용어:** Node/Express는 Vision **서비스 주소를 발견/전달**하지만 Vision gRPC endpoint 자체를 호스팅하지 않는다. 실제 endpoint는 FastAPI Vision Service가 소유한다.  
> **스키마 마이그레이션 기준:** Prisma Migrate 단일 소유; FastAPI는 별도 migration을 실행하지 않는다.


## 1. 설계 기준

본 ERD는 다음 기능을 기준으로 설계한다.

- 실시간 차량 위치 관제
- 차량별 운행 경로 표시
- 경로 이탈 감지
- 경로 재탐색 및 변경 이력 관리
- YOLO 기반 객체 탐지
- 객체와 차량 사이 거리 측정
- 위험 기준 충족 시 관제 경고 생성
- 위험 이벤트 PostgreSQL 저장 및 조회
- 위험 이벤트 이미지 저장
- 누적 위험 및 운행 통계 분석

> 기존의 **운송 목표 / 배차 계획(추천·확정 등 계획 수립 기능)은 본 ERD에서 제외한다.** 단, 통계 화면에 배차 관련 수치(운송 목표 수, 완료율 등)를 표시하기 위한 **최소한의 `transport_goal` 테이블만 예외적으로 포함**한다 (v6, 아래 1.1 참고). 배차 추천 알고리즘, 계획 버전 관리, 계획-차량 매핑(`dispatch_plan`, `dispatch_assignment`, `dispatch_assignment_goal`)은 여전히 범위 밖이다.

---

## 1.1 변경 이력

| 버전 | 변경 내용 | 사유 |
|---|---|---|
| v1 | 최초 설계 (12개 테이블, `vehicle_camera` 포함) | — |
| v2 | `vehicle_camera` 테이블 제거, 카메라/캘리브레이션 정보를 `vehicle`에 통합 | 차량당 카메라 1대 전제. 1:N 관계가 필요 없어 JOIN 테이블 유지 비용만 발생 |
| v2 | `detection_event`에 `vehicle_code`, `class_name`, `display_name`, `warning_distance_m` 비정규화 추가 | `detection_event`는 조회 빈도가 가장 높은 핵심 테이블. `vehicle`/`object_class` JOIN을 제거해 이벤트 로그·재생·통계 화면이 대부분 단일 테이블 스캔으로 처리되도록 함 |
| v3 | `detection_event`에 `frame_id` 추가 | 당시 AI 백엔드 파이프라인(안드로이드 → Redis → GPU 탐지 서버 → 백엔드 → 관제실)이 `frame_id` 기준으로 프레임을 추적하는데, 이 값을 저장하는 컬럼이 없었음. 특정 탐지 결과가 어느 원본 프레임에서 나왔는지 역추적할 수 없어 디버깅·재생 화면 동기화가 불가능했던 문제를 해결 |
| v3 | `trip_video` 테이블 신규 추가 | `event_image`는 위험 이벤트 순간의 스냅샷만 저장하므로, 운행기록 재생 화면(영상 + GPS + 탐지결과 동기화 재생)에 필요한 **연속 영상 파일 자체에 대한 참조**가 어디에도 없었음. 재생 화면 구현 자체가 불가능한 누락이었음 |
| v4 | `VEHICLE \|\|--o{ ALERT` 관계 라벨을 `receives` → `concerns`로 수정 | 실제로는 관제사(`platform_account`)가 `alert.acknowledged_by`로 확인/처리하며, 차량으로 알림이 전달(push)되는 경로는 스키마 어디에도 없음. `receives`는 차량이 알림을 수신한다는 잘못된 인상을 주므로, 차량이 경고의 "대상"일 뿐임을 정확히 반영하도록 수정. FK(`alert.vehicle_id`) 자체는 변경 없음 |
| v5 | `alert`에 `trip_id` 컬럼 추가, `alert_type`에 `'TRIP_COMPLETED'` 추가, 이벤트 연결 제약을 3-way로 확장 (Gap 1 대응) | 목업 대시보드의 실시간 이벤트 피드에 "목적지 도착 완료" 같은 운행 완료 이벤트가 위험 알림과 함께 노출되는데, 기존 `alert`는 `detection_event`/`route_deviation`만 연결 가능해 이 이벤트의 근거가 없었음. 알림성 이벤트를 `alert` 하나로 통일하기 위해 `trip_id` 연결 케이스를 추가 |
| v5 | `alert`에 `operator_note` 컬럼 추가 (Gap 2 대응) | 이벤트 상세 화면의 "메모 추가" 기능이 저장할 곳이 없었음. 시스템 생성 메시지(`alert_message`)와 관제사 자유 텍스트 코멘트(`operator_note`)의 용도를 분리 |
| v5 | 위치 텍스트(주소/지명)는 스키마에 저장하지 않기로 결정 (Gap 3 대응) | `vehicle_position`/`detection_event` 화면에 표시되는 "부산 강서구" 같은 지명은 컬럼 추가 없이 화면 렌더링 시점에 역지오코딩 API로 변환하는 방식으로 확정. 고빈도로 쌓이는 `vehicle_position`에 매 행마다 지명을 저장하는 비용을 피하기 위함 |
| v6 | `transport_goal` 테이블 신규 추가 (통계 전용, 최소 스펙) | 대시보드/통계 화면에 "운송 목표 진행률 68%", "운송 목표 완료율 78% (7/9)", "운송목표 9건 · 완료 7건 · 진행중 1건 · 지연예상 1건" 같은 배차 관련 수치를 표시하려면 최소한 목표의 존재·상태·배정 차량 정보가 필요했음. 다만 배차 추천 알고리즘, 계획 버전 관리, 계획-차량 매핑 등 배차 계획 기능 자체(`dispatch_plan`, `dispatch_assignment`, `dispatch_assignment_goal`)는 여전히 범위 밖이며, `transport_goal`은 통계 집계만을 목적으로 한 최소 스펙임 |
| v7 | `trip`에 `ai_summary`, `ai_summary_generated_at` 컬럼 추가 | overview.md 고도화 기능 F("운행 종료 시 LLM으로 자연어 요약 생성")가 정의되어 있었으나, 생성된 요약을 저장할 컬럼이 어디에도 없었음. 매번 재생성하는 비용을 피하기 위해 `trip`에 직접 저장 (운행 1건당 요약 1개, 1:1 관계) |
| v8 | PostGIS extension 채택. `vehicle_position`/`route_deviation`/`detection_event`/`trip`/`transport_goal`에 `geography(Point, 4326)` 생성 컬럼 추가, `route`에 `route_line geography(LineString, 4326)` 컬럼 추가 | `route_deviation.deviation_distance_m`가 지금까지 애플리케이션 코드에서 점 대 점 근사로 계산되던 것을, `ST_Distance(vehicle_point, route_line)`로 정확한 선분 거리 계산이 가능해짐. 근접 차량 조회 등 공간 쿼리도 GiST 인덱스로 처리 가능. 기존 `latitude`/`longitude` 컬럼은 그대로 유지(생성 컬럼 추가 방식)하여 기존 조회 코드 영향 없음 |
| v9 | `latitude`/`longitude` 컬럼을 완전히 제거하고 PostGIS `geography(Point, 4326)`을 유일한 위치 저장 방식으로 전환 (`vehicle_position`, `route_deviation`, `detection_event`, `trip`의 `origin_location`/`destination_location`, `transport_goal.destination_location`) | v8의 "위경도 컬럼 + 생성 컬럼 병행" 방식은 저위험이지만 위치 정보의 소스가 이원화되는 문제가 있었음. 팀 결정에 따라 PostGIS를 유일한 소스로 단일화. 기존에 `latitude`/`longitude`를 직접 읽던 조회 쿼리는 `ST_Y`/`ST_X` 또는 `ST_AsGeoJSON` 추출 방식으로 수정이 필요함 (v8에서 피하려던 마이그레이션 비용을 감수하기로 결정) |
| v10 | 데이터 액세스 레이어 아키텍처 결정: PostGIS 컬럼이 없는 7개 테이블은 Prisma Client, PostGIS 컬럼이 있는 6개 테이블은 TypedSQL/`$queryRaw`로 접근 (스키마 변경 없음) | Prisma ORM이 PostGIS `geography` 타입을 네이티브로 지원하지 않음. 이 경계 규칙이 문서화되어 있지 않으면 개발자마다 접근 방식이 달라지는 문제가 발생함 |
| v11 | `detection_event`에 `pitch_at_capture_deg`, `roll_at_capture_deg`, `telemetry_source` 컬럼 추가 | 알럿 리플레이 화면에서 "왜 이 거리로 계산되었는가"를 사후 감사하려면, 거리 계산(ground-plane projection)에 실제로 사용된 순간 pitch/roll을 보존해야 함. `vehicle_id`/`frame_id`별 고빈도 IMU 테이블(`frame_telemetry`)도 검토했으나, 실제 소비처가 모두 이미 영속화되는 `detection_event` 행에서 출발하므로 채택하지 않고 `detection_event`에 직접 추가 |
| v12 | 백엔드를 두 개의 서비스로 분리: **FastAPI**(Android로부터 프레임 수신, GPU 추론 서버 dispatch, 관제 대시보드로 실시간 push)와 **Node/Express**(그 외 전체 — 인증, 차량/운전자/운행 관리, 경로 계획·이탈 감지, GPS 수신, 알림 처리, 영상 등록/재생, 운송 목표 통계). 두 서비스가 동일 PostgreSQL을 각자 직접 연결해 사용. `detection_event`/`event_image`는 FastAPI가 쓰기(SQLAlchemy + GeoAlchemy2), `alert`는 발생 원인에 따라 쓰기 주체가 갈림(비전 감지 기반 = FastAPI, 경로 이탈/운행 완료 = Node). 스키마 마이그레이션은 계속 Prisma가 단일 기준점 (`schema.prisma`가 이미 13개 테이블 전체를 선언하므로) | 비전 추론 파이프라인(프레임량, GPU 동시성 제한)과 관제 업무 로직(CRUD, 통계, 인증)은 배포·스케일 특성이 달라 서비스 경계를 분리. v10의 Prisma+TypedSQL 경계 규칙은 단일 Node 백엔드를 전제로 작성되어 있었으므로, 분리 이후 테이블/연산 단위 소유권 규칙을 이 문서에 직접 반영 |
| v13 | **최종 아키텍처 다이어그램을 시스템 아키텍처의 단일 기준점(source of truth)으로 확정.** 실시간 비전 경로를 Android → GPU(gRPC inference), Android → Tauri(gRPC preview), GPU → Tauri(gRPC detections), Android local H.264 encoder → Object Storage, GPU → PostgreSQL(async metadata persistence)로 정렬. 프레임 정확 식별자는 `session_id + frame_id`, 소스 타임라인은 `capture_timestamp_ns`, 재생은 `capture_timestamp_ns ↔ video_pts_us` time-anchor 매핑을 사용하도록 변경. 이를 구현하기 위해 `frame_inference`, `video_time_anchor` 테이블을 추가하고 `trip_video`/`detection_event`의 프레임 동기화 필드를 보강 | 기존 v12의 FastAPI 프레임 ingest/relay 경로가 최종 다이어그램과 불일치했으며, `frame_id` 단독과 FPS 기반 재생 계산으로는 카메라 세션 재시작·프레임 드롭·인코더 PTS 차이를 안전하게 처리할 수 없었음 |
| v14 | GPU → PostgreSQL의 `async metadata insert` 의미를 구현 규칙으로 명확화. GPU post-processing은 DB COMMIT을 기다리지 않고 **bounded in-process persistence queue**에 결과를 enqueue하며, 별도 async DB writer가 짧은 시간/개수 단위로 batch INSERT한다. queue/worker는 내부 구현 상세이므로 최상위 아키텍처 다이어그램에는 별도 컴포넌트로 표시하지 않음 | PostgreSQL 지연 또는 일시 장애가 추론 critical path와 CUDA 공급을 막지 않도록 하고, 다이어그램의 단순한 `async metadata insert` 화살표와 실제 구현 의미를 일치시키기 위함 |
| v15 | **서비스 경계를 최종 확정**: Node/Express는 auth/bootstrap/RBAC 및 일반 business/control API를 소유하고, FastAPI Vision Service는 같은 배포 단위 안에서 FastAPI HTTP endpoint + gRPC inference server + GPU model을 운용한다. Android → Tauri live preview는 두 backend를 모두 우회하는 direct media path로 유지한다. Node auth/bootstrap 응답은 JWT와 함께 Vision Service Address(endpoint descriptor)를 반환하며, Tauri의 history/business API는 Node를 통해 조회한다. FastAPI Vision은 Node가 발급한 credential을 검증하지만 별도 auth authority가 되지 않는다. | 기존 v14 문서가 GPU inference server를 FastAPI와 분리된 별도 서비스처럼 읽힐 수 있게 표현하고 Tauri↔Node auth/bootstrap 관계를 충분히 드러내지 못했던 점을 수정. 이는 service ownership 변경이며 schema table 수는 15개로 유지 |
| v16 | `system_user` 테이블을 `platform_account`로 명명 변경하고 Node/Prisma 및 ERD 표기를 일치시킴 | 플랫폼 계정의 역할을 더 명확히 표현하고, 실제 Prisma 모델/API와 데이터베이스 테이블 명칭을 통일 |

---

### DBMS

- PostgreSQL
- **PostGIS extension** 사용 (v8부터 채택)

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
```

### 설계 원칙

- PostgreSQL `ENUM TYPE`은 사용하지 않는다.
- 상태값은 `VARCHAR`와 `CHECK` 제약조건으로 관리한다.
- PK는 기본적으로 `BIGSERIAL`을 사용한다. 단, `frame_inference`는 외부 pipeline의 자연 identity인 `(session_id, frame_id)` composite PK를 사용한다.
- 시간 정보는 `TIMESTAMPTZ`를 사용한다.
- frame sync용 카메라 monotonic timestamp는 `BIGINT capture_timestamp_ns`로 별도 저장하며 `TIMESTAMPTZ`/network arrival time과 의미를 섞지 않는다.
- exact frame identity는 `session_id + frame_id`, replay mapping은 `capture_timestamp_ns ↔ video_pts_us`를 사용한다.
- 위치 정보는 **PostGIS `geography(Point, 4326)` 컬럼만 사용한다.** `latitude`/`longitude` 이중 컬럼은 두지 않는다 (v9, 아래 "PostGIS 도입" 참고).
- 경로 데이터는 `encoded_polyline`/`route_geojson`(TEXT/JSONB) 표시용 컬럼을 유지하되, `route`에는 실제 공간 연산(경로 이탈 거리 등)에 쓰이는 `route_line geography(LineString, 4326)` 컬럼을 추가한다.
- 이미지 파일 자체를 DB에 저장하기보다 파일 경로 또는 URL을 저장한다.
- 테이블명과 컬럼명은 `snake_case`를 사용한다.

---

### PostGIS 도입 (v8) → 단일 소스로 전환 (v9)

> **채택 이유**: `route_deviation.deviation_distance_m`는 지금까지 애플리케이션 코드에서 "차량 위치 ↔ 가장 가까운 경로 샘플 포인트" 간 거리로 근사 계산해야 했다(선분에 대한 수선의 발 거리가 아니라 점 대 점 거리 근사). PostGIS 도입으로 `ST_Distance(vehicle_point, route_line)` 한 번으로 정확한 거리를 구할 수 있고, "반경 N m 이내 차량 조회" 같은 근접 쿼리도 GiST 인덱스로 빠르게 처리 가능해진다.
>
> **v8 → v9 변경**: v8에서는 `latitude`/`longitude`를 유지하고 PostGIS `geography` 생성 컬럼을 옆에 추가하는 저위험 방식을 택했으나, v9에서 **`latitude`/`longitude` 컬럼을 완전히 제거**하고 `geography(Point, 4326)` 컬럼 하나만 남기기로 결정했다. 위치 정보의 소스가 두 개(위경도 컬럼 + 생성 컬럼)로 이원화되어 있는 것 자체를 없애, "어느 쪽이 진짜 값이냐"는 혼란과 컬럼 중복 저장 비용을 제거하는 것이 목적이다.
>
> **컬럼 정의 (v9)**: 더 이상 생성 컬럼(GENERATED ALWAYS AS)이 아니라, 애플리케이션이 직접 값을 채워 넣는 일반 컬럼이다.
> ```sql
> location geography(Point, 4326) NOT NULL  -- 또는 nullable, 테이블별 원래 제약을 따름
> ```
>
> **쓰기(INSERT) 패턴**: 위경도 값을 애플리케이션에서 바로 geography로 변환해서 넣는다.
> ```sql
> INSERT INTO vehicle_position (vehicle_id, location, speed_kmh, recorded_at)
> VALUES (
>     1,
>     ST_SetSRID(ST_MakePoint(:longitude, :latitude), 4326)::geography,
>     42.0,
>     NOW()
> );
> ```
> (인자 순서 주의: `ST_MakePoint(경도, 위도)` — 경도가 먼저다)
>
> **읽기(SELECT) 패턴**: 지도 렌더링 등 위경도 숫자값이 필요한 곳에서는 조회 시점에 추출한다.
> ```sql
> SELECT
>     ST_Y(location::geometry) AS latitude,
>     ST_X(location::geometry) AS longitude
> FROM vehicle_position
> WHERE vehicle_id = 1
> ORDER BY recorded_at DESC
> LIMIT 1;
> ```
> 또는 프론트엔드에 GeoJSON으로 바로 내려주고 싶다면 `ST_AsGeoJSON(location)`을 사용한다.
>
> **영향받는 코드**: v8 방식과 달리, 기존에 `latitude`/`longitude` 컬럼을 직접 읽던 모든 조회 쿼리(관제실 지도, 이벤트 상세, 재생 화면 등)를 `ST_Y`/`ST_X` 또는 `ST_AsGeoJSON` 추출 방식으로 **수정해야 한다.** 이는 v8에서 피하려던 마이그레이션 비용을 그대로 지불하는 것이며, 팀이 이 트레이드오프를 인지하고 결정한 것으로 간주한다.
>
> **적용 대상**: `vehicle_position`, `route_deviation`, `detection_event`, `trip`(출발/도착 각각), `transport_goal`(목적지). `route`의 `route_line geography(LineString, 4326)`은 이미 v8부터 생성 컬럼이 아닌 일반 컬럼이었으므로 변경 없음.

---

### 서비스 아키텍처 및 데이터 액세스 레이어 (v13 / v14 / v15)

> **최종 아키텍처 다이어그램이 시스템 아키텍처의 기준점이다.** ERD 문서는 그 다이어그램을 DB/서비스 소유권 관점에서 상세화한다. 과거 v12의 FastAPI ingest/relay 구조와, v14까지의 "GPU inference server가 FastAPI와 분리된 별도 네트워크 서비스"처럼 보이는 표현은 현재 구현 기준이 아니다.

현재 시스템은 세 개의 명확한 plane으로 나눈다.

```text
MEDIA PLANE
Android ──direct gRPC live frames──────────────────────────────► Tauri

VISION PLANE
Android ──gRPC FrameEnvelope──► FastAPI Vision Service + GPU
                                   │
                                   ├─gRPC detections──────────► Tauri
                                   └─async/batched metadata───► PostgreSQL

CONTROL / BUSINESS PLANE
Tauri ──HTTPS REST auth/business/history──► Node / Express
Tauri ◄─JWT + Vision Service Address──────── Node / Express

Android ──HTTPS device bootstrap──────────► Node / Express
Android ◄─Vision/Dashboard Service Address + device token / upload credential─ Node / Express

Node / Express ──business data/history/replay queries─────────► PostgreSQL
Android ──local H.264 HTTP PUT─────────────────────────────────► Object Storage
Tauri ──presigned replay Range GET─────────────────────────────► Object Storage
```

- **Node/Express = control/business authority.** `platform_account` 인증, RBAC, JWT 발급, service bootstrap/discovery, 차량/운전자/운행/경로/알림/통계/history/replay API를 담당한다.
- **Auth/bootstrap 응답에는 Vision Service Address(endpoint descriptor)를 포함한다.** 실제 Vision gRPC endpoint는 FastAPI Vision Service가 소유한다. 서비스 주소는 JWT claim에 박아 넣기보다 token과 나란히 bootstrap/service descriptor로 반환한다. routing 정보는 identity보다 자주 바뀔 수 있기 때문이다.
- **FastAPI Vision Service + GPU는 하나의 배포 단위다.** 같은 Python process/container에서 FastAPI HTTP endpoint(health/readiness/status/admin 등)와 gRPC server를 별도 port로 실행하고, YOLO model은 한 번만 GPU에 load한다. 실제 고빈도 inference transport는 gRPC다.
- **FastAPI Vision Service는 별도 인증 authority가 아니다.** Node가 발급한 operator/vision token 또는 device credential을 gRPC metadata/HTTP header에서 검증한다. 매 요청마다 Node에 round-trip하지 않도록 JWT public-key 검증 또는 동등한 local verification 방식을 사용한다.
- **Android → Tauri preview는 direct media path다.** raw/live frame을 FastAPI나 Node에 relay시키지 않는다. 이 경로를 직접 연결하는 것이 Tauri desktop client를 채택한 핵심 이유다.
- **Android가 frame identity의 원본이다.** `session_id`, `frame_id`, `capture_timestamp_ns`는 downstream에서 그대로 전달한다.
- **Tauri live view는 DB를 통하지 않는다.** Android frame stream과 FastAPI Vision detection stream을 `session_id + frame_id`로 exact join하고 짧은 display buffer를 둔다.
- **Tauri는 PostgreSQL에 직접 연결하지 않는다.** event/history/replay metadata는 Node REST API를 통해 조회한다. 반면 H.264 replay bytes는 Node가 발급한 presigned URL을 사용해 Object Storage에서 직접 Range GET할 수 있다.
- **Replay alignment**는 `frame_id / fps`가 아니라 `capture_timestamp_ns ↔ video_pts_us` time anchor를 사용한다. network arrival time은 sync key가 아니다.

#### 테이블별 소유 서비스 및 액세스 레이어

| 테이블 | 연산 | 소유 서비스 | 액세스 레이어 |
|---|---|---|---|
| `platform_account` | 전체 + operator auth/RBAC | **Node** | Prisma Client |
| `vehicle` | INSERT/UPDATE | Node | Prisma Client |
| `vehicle` | SELECT (카메라 캘리브레이션, 거리 계산용) | FastAPI Vision (읽기 캐시) | Node internal context API/캐시 |
| `driver` | 전체 | Node | Prisma Client |
| `trip` | INSERT/UPDATE | Node | 혼합 — TypedSQL(좌표 쓰기), Prisma Client(상태/요약) |
| `trip` | SELECT (차량별 활성 `trip_id`) | FastAPI Vision (읽기 캐시) | Node internal context API/캐시 |
| `trip_video` | 메타데이터 등록/조회 | Node | Prisma Client |
| `video_time_anchor` | INSERT/조회 | Node recording/replay metadata path | Prisma Client 또는 batch INSERT |
| `route` | 전체 | Node | TypedSQL |
| `vehicle_position` | 전체 | Node | TypedSQL |
| `route_deviation` | 전체 | Node | TypedSQL |
| `object_class` | INSERT/UPDATE | Node | Prisma Client |
| `object_class` | SELECT (`warning_distance_m`, `display_name`) | FastAPI Vision (읽기 캐시) | Node internal context API/캐시 |
| `frame_inference` | INSERT (inferred frame metadata) | **FastAPI Vision** | **async/batched DB writer** (`asyncpg` 또는 SQLAlchemy async) |
| `frame_inference` | SELECT (replay/debug/latency analysis) | Node | Prisma Client/TypedSQL |
| `detection_event` | INSERT (위험/대표 이벤트, §6.3 참고) | **FastAPI Vision** | SQLAlchemy + GeoAlchemy2 또는 동등한 PostGIS writer |
| `detection_event` | SELECT (이벤트 로그, 재생, 통계, 클러스터링) | Node | TypedSQL |
| `event_image` | INSERT | **FastAPI Vision** | Object Storage + DB metadata write |
| `event_image` | SELECT | Node | Prisma Client |
| `alert` | INSERT — 비전 감지 기반(`detection_event` 연결) | FastAPI Vision | persistence path의 event transaction |
| `alert` | INSERT — 경로 이탈 또는 `TRIP_COMPLETED` | Node | Prisma Client |
| `alert` | UPDATE(확인/메모/상태), SELECT | Node | Prisma Client |
| `transport_goal` | 전체 | Node | 혼합 — TypedSQL(쓰기), Prisma Client(비GIS 읽기) |

`video_time_anchor`는 Android encoder가 만드는 `capture_timestamp_ns ↔ video_pts_us` mapping이다. H.264 segment의 `trip_video` metadata와 함께 Node control/replay path로 전달하여 영속화한다. 이 저빈도 recording metadata path는 direct live frame path와 분리한다.

**v15에서는 인증 자체 때문에 새 ERD table을 추가하지 않는다.** 관제 사용자 인증은 이미 `platform_account`가 담당한다. Android device credential의 발급/회전/폐기 이력을 DB UI에서 관리해야 하는 요구가 생기면 별도의 `vehicle_device_credential` 테이블을 추가할 수 있지만, MVP에서는 deployment/provisioning credential로 관리할 수 있다. 따라서 현재 table 수는 15개를 유지한다.

#### FastAPI Vision → PostgreSQL 비동기 영속화 규칙 (v14 / v15)

최종 아키텍처의 `async metadata insert` 화살표는 **"async DB driver를 사용해서 요청 안에서 `await INSERT`한다"는 뜻이 아니다.** PostgreSQL은 inference critical path에서 분리한다.

```text
GPU post-processing
       │
       ├─► gRPC detection response → Tauri
       │
       └─► enqueue(metadata)
                │
                ▼
        bounded in-process queue
                │
                ▼
         async DB writer worker
                │
           batch INSERT/COMMIT
                │
                ▼
            PostgreSQL
```

구현 규칙:

- post-processing은 DB COMMIT을 기다리지 않고 다음 inference를 진행한다.
- persistence queue는 **bounded**로 둔다. PostgreSQL 장애 시 pending coroutine/task가 무제한 증가해서 inference process 메모리를 고갈시키지 않게 한다.
- DB writer는 예: `N rows` 또는 `20~100 ms` 중 먼저 충족되는 조건으로 batch flush한다. 정확한 값은 부하 테스트로 조정한다.
- 일반 `frame_inference` metadata는 overload 시 sampling/drop 정책을 적용할 수 있지만, `DANGER` 등 실제 `detection_event`/`alert`는 우선순위를 높여 보존하는 정책을 권장한다.
- queue depth, dropped-persistence count, DB batch latency는 운영 metric으로 노출한다.
- queue/worker는 **FastAPI Vision service 내부 구현 상세**이므로 최상위 아키텍처 다이어그램에는 별도 박스로 추가하지 않는다. 다이어그램에서는 `async metadata insert` 한 개의 화살표로 표현한다.

#### FastAPI Vision이 읽는 Node 소유 context

FastAPI Vision service는 프레임 처리 경로에서 Node 소유 데이터 3가지를 필요로 한다. 프레임마다 DB/API live query를 하지 않고 프로세스 메모리에 캐시한다.

| 데이터 | 출처 | 갱신 주기 | 비고 |
|---|---|---|---|
| `vehicle` 캘리브레이션 필드(`camera_height_m`, `camera_pitch_deg`, `camera_roll_deg`, `camera_yaw_deg`, `focal_length_mm`, `sensor_width_mm`) | Node 소유 `vehicle` | 시작 시 1회 + 긴 TTL(예: 5분) | 재캘리브레이션 시에만 변경 |
| `object_class` 기준값(`warning_distance_m`, `display_name`) | Node 소유 `object_class` | 시작 시 1회 + 긴 TTL | 관리자가 드물게 변경 |
| 차량별 활성 `trip_id` | Node 소유 `trip` | 짧은 TTL(예: 5~10초) 또는 운행 시작/종료 시 무효화 | 운행 경계에서 바뀌므로 앞의 둘보다 실시간성 필요 |

구현 방식 예: Node에 내부 전용 endpoint(예: `GET /internal/vehicles/{id}/context`)를 두어 calibration + active trip + object-class policy version을 반환하고 FastAPI Vision service가 주기적으로 갱신한다.

#### 마이그레이션 소유권

스키마 마이그레이션은 계속 **Prisma Migrate를 단일 기준점**으로 유지한다. v13에서 `frame_inference`, `video_time_anchor`가 추가되어 총 15개 테이블이 되며 `schema.prisma`가 모두 선언한다.

FastAPI Vision service는 자체 schema migration을 실행하지 않는다. 런타임에서 필요한 writer/model(`frame_inference`, `detection_event`, `event_image`, vision-origin `alert`)은 Prisma schema와 동기화하고, CI에서 실제 PostgreSQL schema와 FastAPI Vision service의 SQLAlchemy/SQL statement 계약을 대조하는 drift check를 권장한다.

# 2. 전체 ERD

색상은 **현재 쓰기/관리 책임**을 나타낸다 — 초록(teal) = Node/Express 중심, 보라(purple) = FastAPI Vision service 중심, 주황(amber) = 읽기/쓰기 책임이 서비스 간에 나뉨.

```mermaid
erDiagram

    SYSTEM_USER ||--o{ ALERT : acknowledges

    VEHICLE ||--o{ VEHICLE_POSITION : sends
    VEHICLE ||--o{ TRIP : operates
    VEHICLE ||--o{ FRAME_INFERENCE : produces
    VEHICLE ||--o{ DETECTION_EVENT : generates
    VEHICLE ||--o{ ROUTE_DEVIATION : has
    VEHICLE ||--o{ ALERT : concerns

    DRIVER ||--o{ TRIP : drives

    TRIP ||--o{ ROUTE : has
    TRIP ||--o{ VEHICLE_POSITION : records
    TRIP ||--o{ FRAME_INFERENCE : contains
    TRIP ||--o{ DETECTION_EVENT : occurs_during
    TRIP ||--o{ ROUTE_DEVIATION : detects
    TRIP ||--o{ TRIP_VIDEO : recorded_as
    TRIP ||--o{ ALERT : completes

    TRIP_VIDEO ||--o{ VIDEO_TIME_ANCHOR : aligns

    ROUTE ||--o{ ROUTE_DEVIATION : based_on

    OBJECT_CLASS ||--o{ DETECTION_EVENT : classified_as

    VEHICLE ||--o{ TRANSPORT_GOAL : is_assigned
    TRIP ||--o{ TRANSPORT_GOAL : fulfills

    DETECTION_EVENT ||--o{ EVENT_IMAGE : has
    DETECTION_EVENT ||--o{ ALERT : creates

    ROUTE_DEVIATION ||--o{ ALERT : creates

    %% Node/Express 중심
    style SYSTEM_USER fill:#E1F5EE,stroke:#0F6E56,stroke-width:1px
    style DRIVER fill:#E1F5EE,stroke:#0F6E56,stroke-width:1px
    style TRIP_VIDEO fill:#E1F5EE,stroke:#0F6E56,stroke-width:1px
    style VIDEO_TIME_ANCHOR fill:#E1F5EE,stroke:#0F6E56,stroke-width:1px
    style ROUTE fill:#E1F5EE,stroke:#0F6E56,stroke-width:1px
    style VEHICLE_POSITION fill:#E1F5EE,stroke:#0F6E56,stroke-width:1px
    style ROUTE_DEVIATION fill:#E1F5EE,stroke:#0F6E56,stroke-width:1px
    style TRANSPORT_GOAL fill:#E1F5EE,stroke:#0F6E56,stroke-width:1px

    %% FastAPI Vision service 중심
    style FRAME_INFERENCE fill:#EEEDFE,stroke:#534AB7,stroke-width:1px
    style DETECTION_EVENT fill:#EEEDFE,stroke:#534AB7,stroke-width:1px
    style EVENT_IMAGE fill:#EEEDFE,stroke:#534AB7,stroke-width:1px

    %% 혼합 소유/읽기
    style VEHICLE fill:#FAEEDA,stroke:#854F0B,stroke-width:1px
    style OBJECT_CLASS fill:#FAEEDA,stroke:#854F0B,stroke-width:1px
    style TRIP fill:#FAEEDA,stroke:#854F0B,stroke-width:1px
    style ALERT fill:#FAEEDA,stroke:#854F0B,stroke-width:1px
```

---

# 3. 핵심 테이블 목록

| 테이블 | 역할 | 소유 서비스 | 액세스 레이어 |
|---|---|---|---|
| `platform_account` | 관제센터 사용자 | Node | Prisma Client |
| `vehicle` | 차량 기본 정보 + 카메라/캘리브레이션 | Node 쓰기, GPU 읽기 캐시 | Prisma Client / context cache |
| `driver` | 운전자 정보 | Node | Prisma Client |
| `trip` | 실제 운행 기록 | Node 쓰기, GPU active-trip 읽기 캐시 | TypedSQL/Prisma Client |
| `trip_video` | 운행 중 H.264 segment metadata | Node | Prisma Client |
| `video_time_anchor` | `capture_timestamp_ns ↔ video_pts_us` replay mapping | Node recording metadata path | Prisma Client/batch INSERT |
| `route` | 계획 및 재탐색 경로 | Node | TypedSQL |
| `vehicle_position` | 차량 GPS 위치 이력 | Node | TypedSQL |
| `route_deviation` | 경로 이탈 이벤트 | Node | TypedSQL |
| `object_class` | YOLO 객체 클래스 및 경고 기준 | Node 쓰기, GPU 읽기 캐시 | Prisma Client / context cache |
| `frame_inference` | 프레임 단위 AI 결과 metadata (`detections` JSONB, latency/model info) | **FastAPI Vision service (쓰기)**, Node(읽기) | async/batched writer / Prisma·TypedSQL |
| `detection_event` | 위험/대표 객체 탐지 이벤트 (장기 이벤트 이력) | **FastAPI Vision service (쓰기)**, Node(읽기) | GeoAlchemy2 또는 동등 PostGIS writer / TypedSQL |
| `event_image` | 위험 이벤트 캡처 이미지 | **FastAPI Vision service (쓰기)**, Node(읽기) | Object Storage + DB metadata / Prisma |
| `alert` | 관제센터 경고 및 처리 상태 | vision INSERT=GPU, route/trip INSERT+처리=Node | GPU writer / Prisma Client |
| `transport_goal` | 운송 목표 (통계 집계 전용 최소 스펙) | Node | TypedSQL/Prisma Client |

> 최종 아키텍처의 PostgreSQL 박스에서 `detections`로 표시한 것은 ERD의 **`frame_inference`**에 대응한다. 기존 `detection_event`는 모든 inference frame을 저장하는 기술 로그가 아니라, 위험/통계에 의미 있는 객체 이벤트만 선별해 장기 보관하는 domain event다. `time_anchors`는 **`video_time_anchor`**에 대응한다.

---

# 4. 사용자 / 차량 기본 정보

## 4.1 platform_account

관제센터 웹 사용자를 저장한다.

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| `user_id` | BIGSERIAL | PK | 사용자 ID |
| `login_id` | VARCHAR(100) | UNIQUE, NOT NULL | 로그인 ID |
| `password_hash` | VARCHAR(255) | NOT NULL | 암호화된 비밀번호 |
| `user_name` | VARCHAR(100) | NOT NULL | 사용자 이름 |
| `role` | VARCHAR(30) | NOT NULL | 사용자 역할 |
| `is_active` | BOOLEAN | DEFAULT TRUE | 활성화 여부 |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() | 생성 시각 |
| `updated_at` | TIMESTAMPTZ | DEFAULT NOW() | 수정 시각 |

### role

```sql
CHECK (
    role IN (
        'ADMIN',
        'OPERATOR',
        'VIEWER'
    )
)
```

---

## 4.2 vehicle

관제 대상 트럭 정보를 저장한다.

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| `vehicle_id` | BIGSERIAL | PK | 차량 ID |
| `vehicle_code` | VARCHAR(50) | UNIQUE, NOT NULL | TRUCK-01 등 |
| `plate_number` | VARCHAR(30) | UNIQUE | 차량 번호 |
| `vehicle_name` | VARCHAR(100) |  | 차량명 |
| `max_load_kg` | NUMERIC(10,2) |  | 최대 적재 중량 |
| `height_m` | NUMERIC(5,2) |  | 차량 높이 |
| `width_m` | NUMERIC(5,2) |  | 차량 폭 |
| `length_m` | NUMERIC(5,2) |  | 차량 길이 |
| `vehicle_status` | VARCHAR(30) | NOT NULL | 차량 상태 |
| `stream_url` | TEXT |  | 카메라 스트림 주소 |
| `camera_height_m` | NUMERIC(5,3) |  | 카메라 장착 높이 (단안 거리 계산용) |
| `camera_pitch_deg` | NUMERIC(6,2) |  | 초기 장착 pitch (단안 거리 계산용) |
| `camera_roll_deg` | NUMERIC(6,2) |  | 초기 장착 roll |
| `camera_yaw_deg` | NUMERIC(6,2) |  | 초기 장착 yaw |
| `focal_length_mm` | NUMERIC(6,2) |  | 카메라 초점거리 |
| `sensor_width_mm` | NUMERIC(6,2) |  | 카메라 센서 폭 |
| `is_active` | BOOLEAN | DEFAULT TRUE | 운용 여부 |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() | 생성 시각 |
| `updated_at` | TIMESTAMPTZ | DEFAULT NOW() | 수정 시각 |

### vehicle_status

```sql
CHECK (
    vehicle_status IN (
        'READY',
        'DRIVING',
        'STOPPED',
        'MAINTENANCE',
        'OFFLINE'
    )
)
```

---

## 4.3 driver

운전자 기본 정보를 저장한다.

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| `driver_id` | BIGSERIAL | PK | 운전자 ID |
| `driver_name` | VARCHAR(100) | NOT NULL | 운전자 이름 |
| `phone` | VARCHAR(30) |  | 연락처 |
| `license_number` | VARCHAR(100) | UNIQUE | 운전면허 또는 식별번호 |
| `driver_status` | VARCHAR(30) | NOT NULL | 운전자 상태 |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() | 생성 시각 |
| `updated_at` | TIMESTAMPTZ | DEFAULT NOW() | 수정 시각 |

```sql
CHECK (
    driver_status IN (
        'AVAILABLE',
        'DRIVING',
        'OFF_DUTY'
    )
)
```

---

> `vehicle_camera` 테이블은 제거됨 — 차량당 카메라 1대 전제이므로 카메라 및 캘리브레이션 정보는 `vehicle` 테이블에 통합.

---

# 5. 실제 운행 및 경로

## 5.1 trip

차량의 실제 운행 단위를 저장한다.

예:

```text
TRUCK-03
부산 물류센터 → 부산항
2026-08-25 09:00 출발
```

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| `trip_id` | BIGSERIAL | PK | 운행 ID |
| `vehicle_id` | BIGINT | FK, NOT NULL | 차량 |
| `driver_id` | BIGINT | FK | 운전자 |
| `origin_name` | VARCHAR(150) |  | 출발지명 |
| `origin_address` | TEXT |  | 출발지 주소 |
| `origin_location` | geography(Point,4326) |  | 출발지 좌표 (v9, `latitude`/`longitude` 대체) |
| `destination_name` | VARCHAR(150) | NOT NULL | 목적지명 |
| `destination_address` | TEXT |  | 목적지 주소 |
| `destination_location` | geography(Point,4326) | NOT NULL | 목적지 좌표 (v9, `latitude`/`longitude` 대체) |
| `trip_status` | VARCHAR(30) | NOT NULL | 운행 상태 |
| `planned_start_at` | TIMESTAMPTZ |  | 예정 출발 |
| `started_at` | TIMESTAMPTZ |  | 실제 출발 |
| `ended_at` | TIMESTAMPTZ |  | 실제 종료 |
| `actual_distance_m` | INTEGER |  | 실제 운행 거리 |
| `ai_summary` | TEXT |  | LLM이 생성한 운행 자연어 요약 (고도화 F) |
| `ai_summary_generated_at` | TIMESTAMPTZ |  | 요약 생성 시각 |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() | 생성 시각 |
| `updated_at` | TIMESTAMPTZ | DEFAULT NOW() | 수정 시각 |

### trip_status

```sql
CHECK (
    trip_status IN (
        'READY',
        'IN_PROGRESS',
        'PAUSED',
        'COMPLETED',
        'CANCELLED'
    )
)
```

> **`ai_summary` 추가 사유**: overview.md 고도화 기능 F("운행 종료 시 이벤트/탐지 데이터를 LLM에 넣어 자연어 리포트 생성")가 정의되어 있었으나, 생성된 요약 텍스트를 저장할 컬럼이 어디에도 없었다. 매 조회마다 재생성하면 LLM 호출 비용과 지연이 반복 발생하므로, `trip`(운행 1건당 요약 1개, 1:1 관계)에 직접 저장한다. `ai_summary_generated_at`으로 생성 시점을 남겨, 이후 이벤트가 추가로 확정되어도(예: 사후 조치 완료) 요약이 최신 상태인지 판단할 수 있게 한다.

> **`origin_location`/`destination_location` (v9)**: `origin_latitude`/`origin_longitude`, `destination_latitude`/`destination_longitude` 4개 컬럼을 제거하고 이 둘로 대체했다. 삽입 시 `ST_SetSRID(ST_MakePoint(경도, 위도), 4326)::geography`로 변환해서 넣고, 조회 시 위경도 숫자가 필요하면 `ST_Y(origin_location::geometry)`/`ST_X(origin_location::geometry)`로 추출한다 (자세한 패턴은 상단 "PostGIS 도입" 절 참고).

---

---

## 5.1.1 trip_video

운행 중 Android local H.264 encoder가 생성하여 Object Storage에 업로드한 **영상 segment metadata**를 저장한다. 실제 H.264 bytes는 DB가 아니라 Object Storage에 있고, 이 테이블은 replay에서 어떤 파일을 열어야 하는지 가리킨다.

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| `trip_video_id` | BIGSERIAL | PK | 영상 segment ID |
| `trip_id` | BIGINT | FK, NOT NULL | 운행 ID |
| `session_id` | UUID | NOT NULL | Android capture session ID (`FrameEnvelope.session_id`) |
| `segment_index` | INTEGER | NOT NULL | 동일 session 내 H.264 segment 순번 |
| `video_url` | TEXT | NOT NULL | Object Storage 경로 또는 URL |
| `start_frame_id` | BIGINT | NOT NULL | segment 시작 frame ID (범위/디버깅용) |
| `end_frame_id` | BIGINT |  | segment 종료 frame ID (녹화 중이면 NULL) |
| `started_at` | TIMESTAMPTZ | NOT NULL | segment 시작 wall-clock 시각(표시/검색용) |
| `ended_at` | TIMESTAMPTZ |  | segment 종료 wall-clock 시각 |
| `fps` | NUMERIC(5,2) |  | nominal frame rate; replay sync의 source of truth는 아님 |
| `duration_sec` | INTEGER |  | 재생 길이(초) |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() | 생성 시각 |

### 핵심 규칙

`start_frame_id`, `fps`, `started_at`은 파일 범위/표시/진단에 유용하지만 **replay에서 detection을 video position으로 변환하는 주 기준으로 사용하지 않는다.** 프레임 드롭, encoder buffering, 실제 PTS 차이를 처리하기 위해 §5.1.2의 `video_time_anchor`를 사용한다.

한 번의 trip이 길어 여러 H.264 파일로 분할될 수 있으므로 `trip : trip_video = 1 : N`이다.

### 권장 UNIQUE / 인덱스

```sql
UNIQUE (session_id, segment_index);

CREATE INDEX idx_trip_video_trip_start
ON trip_video (trip_id, started_at);

CREATE INDEX idx_trip_video_session
ON trip_video (session_id, segment_index);
```

---

## 5.1.2 video_time_anchor

Android encoder가 알고 있는 **camera capture timeline**과 **encoded-video PTS timeline** 사이의 대응점을 저장한다. 최종 아키텍처의 PostgreSQL `time_anchors` 박스에 대응한다.

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| `time_anchor_id` | BIGSERIAL | PK | anchor ID |
| `trip_video_id` | BIGINT | FK, NOT NULL | anchor가 속하는 H.264 segment |
| `session_id` | UUID | NOT NULL | Android capture session ID |
| `anchor_index` | INTEGER | NOT NULL | 해당 segment 내 anchor 순번 |
| `capture_timestamp_ns` | BIGINT | NOT NULL | CameraX source/capture timeline timestamp |
| `video_pts_us` | BIGINT | NOT NULL | 해당 시점의 encoded video presentation timestamp |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() | 저장 시각 |

### 용도

```text
detection/frame capture_timestamp_ns
            │
            ▼
     nearest surrounding anchors
            │
            ▼
 interpolate / map
            │
            ▼
        video_pts_us
            │
            ▼
       replay seek/render
```

- `capture_timestamp_ns`가 replay alignment의 source timeline이다.
- `video_pts_us`가 H.264 player가 사용하는 media timeline이다.
- `started_at` 또는 network arrival time을 둘 사이의 sync key로 사용하지 않는다.
- PTS가 segment마다 다시 0부터 시작할 수 있으므로 `trip_video_id`를 반드시 포함한다.
- 모든 프레임에 anchor를 저장할 필요는 없다. encoder timestamp가 안정적이면 주기적 anchor + segment boundary anchor로 충분하며, 필요한 주기는 실제 drift 측정으로 결정한다.

### 권장 제약 / 인덱스

```sql
UNIQUE (trip_video_id, anchor_index);

CREATE INDEX idx_video_time_anchor_capture
ON video_time_anchor (session_id, capture_timestamp_ns);

CREATE INDEX idx_video_time_anchor_pts
ON video_time_anchor (trip_video_id, video_pts_us);
```

---

## 5.2 route

A* 또는 OSRM 등으로 계산한 경로를 저장한다.

경로 이탈 후 재탐색하면 동일한 `trip_id`에 새로운 경로를 추가한다.

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| `route_id` | BIGSERIAL | PK | 경로 ID |
| `trip_id` | BIGINT | FK, NOT NULL | 운행 ID |
| `route_version` | INTEGER | NOT NULL | 경로 버전 |
| `route_type` | VARCHAR(30) | NOT NULL | 최초/재탐색 구분 |
| `distance_m` | INTEGER |  | 경로 거리 |
| `duration_sec` | INTEGER |  | 예상 소요 시간 |
| `encoded_polyline` | TEXT |  | 지도 표시용 경로 (표시 캐시) |
| `route_geojson` | JSONB |  | GeoJSON 경로 (표시 캐시) |
| `route_line` | geography(LineString,4326) |  | PostGIS 경로 라인 (v8, 공간 연산용 — 저장 시점에 `ST_GeomFromGeoJSON()`/`ST_LineFromEncodedPolyline()`으로 채움) |
| `is_current` | BOOLEAN | DEFAULT TRUE | 현재 경로 여부 |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() | 생성 시각 |

> **`route_line` 추가 사유 (v8)**: `encoded_polyline`/`route_geojson`은 지도 렌더링용 표시 캐시로 계속 유지하지만, 실제 경로 이탈 거리 계산(`ST_Distance(vehicle_position.location, route.route_line)`)에는 PostGIS 지오메트리 타입이 필요하다. 라우팅 엔진(OSRM 등) 응답을 저장할 때 `ST_LineFromEncodedPolyline(encoded_polyline)` 또는 `ST_GeomFromGeoJSON(route_geojson)`으로 함께 채워 넣는다 (생성 컬럼이 아니라 일반 컬럼 — 응답 형식이 polyline/geojson 둘 중 하나만 오는 경우가 있어 애플리케이션에서 변환 후 저장).

### route_type

```sql
CHECK (
    route_type IN (
        'INITIAL',
        'RECALCULATED'
    )
)
```

### 권장 UNIQUE

```sql
UNIQUE (trip_id, route_version)
```

### 권장 인덱스 (v8)

```sql
CREATE INDEX idx_route_line
ON route
USING GIST (route_line);
```

### 예시

```text
trip_id = 101

route_version = 1
최초 경로

route_version = 2
경로 이탈 후 재탐색

route_version = 3
두 번째 재탐색
```

---

## 5.3 vehicle_position

차량의 GPS 위치를 시간 순서대로 저장한다.

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| `position_id` | BIGSERIAL | PK | 위치 ID |
| `vehicle_id` | BIGINT | FK, NOT NULL | 차량 |
| `trip_id` | BIGINT | FK | 운행 |
| `location` | geography(Point,4326) | NOT NULL | 위치 좌표 (v9, `latitude`/`longitude` 대체) |
| `speed_kmh` | NUMERIC(6,2) |  | 속도 |
| `heading_deg` | NUMERIC(6,2) |  | 진행 방향 |
| `recorded_at` | TIMESTAMPTZ | NOT NULL | 측정 시각 |

### 주요 용도

```text
현재 차량 위치
실제 이동 경로
차량 속도
경로 진행 상태
경로 이탈 판단 (v8부터 route.route_line과 ST_Distance로 정확 계산)
```

### 권장 인덱스

```sql
CREATE INDEX idx_vehicle_position_vehicle_time
ON vehicle_position (
    vehicle_id,
    recorded_at DESC
);

CREATE INDEX idx_vehicle_position_location
ON vehicle_position
USING GIST (location);
```

> **위치 텍스트(주소/지명) 미저장 결정**: 관제실 화면에는 "부산 강서구"처럼 사람이 읽는 지명이 표시되지만, 이 테이블은 `location`(v9)만 저장하고 별도 주소 컬럼은 두지 않는다. 화면 렌더링 시점에 `ST_Y(location::geometry)`/`ST_X(location::geometry)`로 위경도를 추출한 뒤 역지오코딩(reverse geocoding) API를 호출해 지명으로 변환하는 방식을 택했다. `vehicle_position`은 초 단위로 계속 쌓이는 고빈도 테이블이라, 매 행마다 지명을 저장하면 불필요한 API 호출과 저장 비용이 커진다는 판단이다. 조회 시 지연·외부 API 의존성이 생기는 트레이드오프는 있다.

---

## 5.4 route_deviation

차량이 계획된 경로에서 기준 거리 이상 이탈했을 때 저장한다.

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| `deviation_id` | BIGSERIAL | PK | 경로 이탈 ID |
| `vehicle_id` | BIGINT | FK, NOT NULL | 차량 |
| `trip_id` | BIGINT | FK, NOT NULL | 운행 |
| `route_id` | BIGINT | FK, NOT NULL | 이탈 당시 경로 |
| `deviation_distance_m` | NUMERIC(10,2) | NOT NULL | 경로와 떨어진 거리 |
| `location` | geography(Point,4326) | NOT NULL | 발생 좌표 (v9, `latitude`/`longitude` 대체) |
| `detected_at` | TIMESTAMPTZ | NOT NULL | 감지 시각 |
| `resolved_at` | TIMESTAMPTZ |  | 해결 시각 |
| `recalculated_route_id` | BIGINT | FK | 재탐색된 경로 ID |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() | 생성 시각 |

> **`deviation_distance_m` 계산 방식 변경 (v8)**: 이전에는 "차량 위치 ↔ 가장 가까운 경로 샘플 포인트" 간 점 대 점 거리로 근사 계산했다. v8부터는 `ST_Distance(vehicle_position.location, route.route_line)`로 경로 선분에 대한 정확한 수선의 발 거리를 계산해 `deviation_distance_m`에 저장한다.

### 흐름

```text
현재 GPS 위치
    ↓
route.route_line과 ST_Distance 계산 (v8)
    ↓
이탈 거리 계산
    ↓
기준 초과
    ↓
route_deviation 생성
    ↓
alert 생성
    ↓
경로 재탐색
    ↓
새 route 생성
```

### 권장 인덱스 (v8)

```sql
CREATE INDEX idx_route_deviation_location
ON route_deviation
USING GIST (location);
```

---

# 6. 비전 객체 탐지

## 6.1 object_class

YOLO에서 사용하는 객체 클래스와 객체별 경고 기준을 저장한다.

예:

```text
person
bicycle
car
motorcycle
traffic_light
```

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| `class_id` | BIGSERIAL | PK | 내부 ID |
| `model_class_id` | INTEGER | NOT NULL | YOLO 클래스 번호 |
| `class_name` | VARCHAR(100) | NOT NULL | person 등 |
| `display_name` | VARCHAR(100) | NOT NULL | 사람 등 |
| `warning_distance_m` | NUMERIC(6,2) |  | 위험 거리 기준 |
| `is_alert_target` | BOOLEAN | DEFAULT TRUE | 경고 대상 여부 |
| `is_active` | BOOLEAN | DEFAULT TRUE | 사용 여부 |

### 권장 UNIQUE

```sql
UNIQUE (
    model_class_id,
    class_name
)
```

---

## 6.2 frame_inference

최종 아키텍처의 PostgreSQL `detections` 박스에 대응하는 **프레임 단위 inference metadata**다. 한 inference frame에 여러 객체가 있을 수 있으므로 detection list를 JSONB 한 행으로 저장한다.

`frame_inference`는 기술적 replay/debug/성능 분석용이고, `detection_event`는 위험/대표 객체를 선별한 domain event라는 역할 차이를 유지한다.

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| `session_id` | UUID | PK(복합), NOT NULL | Android capture session ID |
| `frame_id` | BIGINT | PK(복합), NOT NULL | session 내 frame ID |
| `capture_timestamp_ns` | BIGINT | NOT NULL | CameraX source timestamp; frame timeline source of truth |
| `vehicle_id` | BIGINT | FK, NOT NULL | 차량 |
| `trip_id` | BIGINT | FK | 활성 운행 |
| `model_version` | VARCHAR(100) | NOT NULL | inference에 실제 사용된 model/version identifier |
| `detections` | JSONB | NOT NULL | 해당 frame의 detection array (bbox, class, confidence, distance, track_id 등) |
| `inference_ms` | NUMERIC(10,3) |  | inference/post-process 측정 지연 |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() | DB 영속화 시각 |

### PK 설계

다른 domain table은 기본적으로 `BIGSERIAL` PK를 쓰지만, 이 테이블은 외부 pipeline에서 이미 확정된 frame identity가 있으므로 예외적으로 다음 composite PK를 사용한다.

```sql
PRIMARY KEY (session_id, frame_id)
```

`frame_id`는 camera/app reconnect 후 다시 시작할 수 있으므로 단독으로 unique하지 않다. 정확한 frame identity는 항상 **`session_id + frame_id`**다.

### 쓰기 성능 규칙

GPU post-processing은 이 테이블에 synchronous INSERT/COMMIT하지 않는다. 결과를 bounded persistence queue에 enqueue하고 별도 async writer가 batch INSERT한다. 따라서 PostgreSQL latency는 다음 frame inference 시작을 block하지 않는다.

### 권장 인덱스

```sql
CREATE INDEX idx_frame_inference_trip_capture
ON frame_inference (trip_id, capture_timestamp_ns);

CREATE INDEX idx_frame_inference_vehicle_capture
ON frame_inference (vehicle_id, capture_timestamp_ns);
```

`detections JSONB` 내부 조건 검색이 실제 hot query가 될 때만 GIN index를 추가한다. 초기부터 무조건 GIN을 추가하면 고빈도 INSERT 비용만 증가할 수 있다.

---

## 6.3 detection_event

객체 탐지 결과 중 DB에 보관할 필요가 있는 이벤트를 저장한다.

실시간 30 FPS 모든 프레임의 모든 탐지 결과를 DB에 저장하기보다는 다음과 같은 데이터를 이벤트로 기록하는 것을 권장한다.

- 위험 거리 기준에 접근한 객체
- 실제 위험 경고가 발생한 객체
- 통계 분석에 필요한 대표 탐지 이벤트

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| `detection_event_id` | BIGSERIAL | PK | 탐지 이벤트 ID |
| `session_id` | UUID | NOT NULL | Android capture session ID — `frame_id` namespace |
| `frame_id` | BIGINT | NOT NULL | session 내부 원본 프레임 식별자 |
| `capture_timestamp_ns` | BIGINT | NOT NULL | CameraX source timestamp (timeline source of truth) |
| `vehicle_id` | BIGINT | FK, NOT NULL | 차량 |
| `vehicle_code` | VARCHAR(50) | NOT NULL | 차량 코드 (비정규화 — vehicle JOIN 제거) |
| `trip_id` | BIGINT | FK | 운행 |
| `model_version` | VARCHAR(100) |  | 이벤트를 생성한 model/version snapshot |
| `class_id` | BIGINT | FK, NOT NULL | 객체 클래스 |
| `track_id` | BIGINT |  | tracker object ID (있는 경우) |
| `class_name` | VARCHAR(100) | NOT NULL | 객체 클래스명 (비정규화 — object_class JOIN 제거) |
| `display_name` | VARCHAR(100) | NOT NULL | 객체 표시명 (비정규화) |
| `confidence` | NUMERIC(5,4) | NOT NULL | YOLO Confidence |
| `distance_m` | NUMERIC(8,2) |  | 객체까지 거리 |
| `warning_distance_m` | NUMERIC(8,2) |  | 당시 위험 기준 (비정규화 — 기록 시점의 object_class.warning_distance_m 스냅샷) |
| `risk_level` | VARCHAR(20) | NOT NULL | 위험 단계 |
| `location` | geography(Point,4326) |  | 차량 위치 좌표 (v9, `latitude`/`longitude` 대체) |
| `bbox_x1` | NUMERIC(10,4) |  | Bounding Box |
| `bbox_y1` | NUMERIC(10,4) |  | Bounding Box |
| `bbox_x2` | NUMERIC(10,4) |  | Bounding Box |
| `bbox_y2` | NUMERIC(10,4) |  | Bounding Box |
| `pitch_at_capture_deg` | NUMERIC(6,3) |  | 이 감지의 거리 계산(ground-plane projection)에 실제로 사용된 순간 pitch — 정적 캘리브레이션(`vehicle.camera_pitch_deg`) + 순간 편차 반영값 (v11) |
| `roll_at_capture_deg` | NUMERIC(6,3) |  | 동일, roll (v11) |
| `telemetry_source` | VARCHAR(20) | CHECK (`DEVICE_SENSOR` \| `SIMULATED`) | 실제 기기 센서 값인지, 재생 로그에서 조회한 값인지 (v11) |
| `detected_at` | TIMESTAMPTZ | NOT NULL | 탐지 시각 |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() | 저장 시각 |

> **`pitch_at_capture_deg`/`roll_at_capture_deg`/`telemetry_source` 추가 사유 (v11)**: 알럿 리플레이 화면에서 "왜 이 거리로 계산되었는가"를 사후에 감사할 수 있어야 한다는 요구사항에서 추가했다. `vehicle_id`/`frame_id`별로 IMU를 저장하는 별도 고빈도 테이블(`frame_telemetry`, ~500Hz 그레인)도 검토했으나 채택하지 않았다 — 실제 소비처(알럿 리플레이, 거리 계산 감사)가 모두 이미 영속화되는 `detection_event` 행에서 출발하며, 어떤 이벤트로도 기록되지 않은 임의의 프레임에서 IMU가 어땠는지 물을 필요가 없기 때문이다. 값은 해당 `detection_event` 행이 INSERT될 때 함께 기록된다.

> **쓰기 주체 및 액세스 레이어 (v13/v14/v15)**: 위험 거리 접근, 실제 경고, 통계 대표 샘플에 해당하는 객체만 FastAPI Vision service의 persistence path가 INSERT한다. `frame_inference`와 달리 모든 frame을 객체 row로 풀어 저장하지 않는다. `location` PostGIS 컬럼은 GeoAlchemy2 또는 동등한 PostGIS-capable writer로 저장하며, Node는 이벤트 로그/재생/통계/클러스터링에서 읽기 전용으로 사용한다.

> **비정규화 설계 의도**: `detection_event`는 조회 빈도가 가장 높은 핵심 테이블이다. 이벤트 로그, 재생, 통계 등 대부분의 화면에서 `vehicle`, `object_class`와 JOIN이 필요했으나, `vehicle_code`, `class_name`, `display_name`, `warning_distance_m`을 기록 시점에 함께 저장하면 대부분의 조회가 단일 테이블 스캔으로 완료된다. FK(`vehicle_id`, `class_id`)는 데이터 무결성을 위해 유지한다.

> **프레임 identity / timeline (v13)**: `frame_id` 단독이 아니라 `session_id + frame_id`가 exact frame identity다. `capture_timestamp_ns`는 Android CameraX가 만든 source timeline timestamp이며 GPU/Tauri/DB에서 그대로 전달·보존한다. `detected_at`/`created_at` 또는 network arrival time은 sync 기준이 아니다. `detection_event`가 장기 보관되는 동안 `frame_inference` retention 정책이 달라질 수 있으므로, 이벤트 자체에도 `session_id`, `frame_id`, `capture_timestamp_ns`, `model_version` snapshot을 보존한다.

> **위치 텍스트(주소/지명) 미저장 결정**: 이벤트 상세 화면에 "부산광역시 강서구" 같은 지명이 표시되지만, 이 테이블도 `vehicle_position`과 동일하게 `location`(v9)만 저장한다. 표시 시점에 `ST_Y`/`ST_X`로 위경도를 추출한 뒤 역지오코딩 API로 변환하는 방식을 따른다 (자세한 사유는 `vehicle_position` 5.3절 참고).

> **`location` (PostGIS) 활용 예**: "특정 반경 내에서 발생한 위험 이벤트" 검색이나 위험도 히트맵(고도화 D)의 공간 클러스터링(`ST_ClusterKMeans` 등)에 활용.

### 권장 인덱스 추가

```sql
CREATE INDEX idx_detection_event_frame
ON detection_event (
    session_id,
    frame_id
);

CREATE INDEX idx_detection_event_trip_capture
ON detection_event (
    trip_id,
    capture_timestamp_ns
);

CREATE INDEX idx_detection_event_location
ON detection_event
USING GIST (location);
```

### confidence

```text
0.94 = 94%
```

### risk_level

```sql
CHECK (
    risk_level IN (
        'NORMAL',
        'CAUTION',
        'DANGER'
    )
)
```

> `confidence`는 객체 탐지 신뢰도이며, 실제 위험 단계와 동일한 값이 아니다.

예:

```text
Person
Confidence = 94%
Distance = 1.8m
Risk Level = DANGER
```

---

## 6.4 event_image

위험 이벤트 발생 시 캡처한 이미지를 저장한다.

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| `event_image_id` | BIGSERIAL | PK | 이미지 ID |
| `detection_event_id` | BIGINT | FK, NOT NULL | 탐지 이벤트 |
| `image_url` | TEXT | NOT NULL | 이미지 경로 또는 URL |
| `thumbnail_url` | TEXT |  | 썸네일 |
| `captured_at` | TIMESTAMPTZ | NOT NULL | 촬영 시각 |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() | 생성 시각 |

### 저장 예시

```text
/files/events/2026/08/25/evt_000123.jpg
```

또는 Object Storage URL을 저장할 수 있다.

> **쓰기 주체 (v13)**: FastAPI Vision service가 위험 이벤트를 확정한 시점에 해당 frame bytes/reference를 이용해 이미지를 Object Storage에 저장하고 이 metadata 행을 영속화한다. Node는 이벤트 상세/갤러리 화면에서 읽기 전용으로 사용한다.

---

# 7. 관제 경고

## 7.1 alert

관제사가 실제로 확인해야 하는 경고를 저장한다.

다음 세 종류의 이벤트를 하나의 경고 테이블에서 관리한다.

```text
객체 접근 위험
경로 이탈
운행(trip) 완료
```

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| `alert_id` | BIGSERIAL | PK | 경고 ID |
| `vehicle_id` | BIGINT | FK, NOT NULL | 차량 |
| `detection_event_id` | BIGINT | FK | 객체 탐지 이벤트 |
| `route_deviation_id` | BIGINT | FK | 경로 이탈 |
| `trip_id` | BIGINT | FK | 완료된 운행 (TRIP_COMPLETED 전용) |
| `alert_type` | VARCHAR(30) | NOT NULL | 경고 유형 |
| `severity` | VARCHAR(20) | NOT NULL | 경고 심각도 |
| `alert_message` | TEXT |  | 화면 표시 메시지 (시스템 생성) |
| `operator_note` | TEXT |  | 관제사 확인/처리 메모 (자유 텍스트) |
| `alert_status` | VARCHAR(30) | NOT NULL | 처리 상태 |
| `acknowledged_by` | BIGINT | FK | 확인 관제사 |
| `acknowledged_at` | TIMESTAMPTZ |  | 확인 시각 |
| `resolved_at` | TIMESTAMPTZ |  | 처리 완료 시각 |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() | 경고 생성 시각 |

### alert_type

```sql
CHECK (
    alert_type IN (
        'OBJECT_PROXIMITY',
        'ROUTE_DEVIATION',
        'TRIP_COMPLETED'
    )
)
```

> `TRIP_COMPLETED`는 위험 경고가 아니라 운행 완료를 알리는 정보성 이벤트이지만, 관제실 대시보드의 실시간 이벤트 피드에서 위험 알림과 함께 시간순으로 노출되어야 하므로 동일한 `alert` 테이블에 통합했다. `severity`는 이 경우 `'INFO'`로 고정하는 것을 권장한다.

### severity

```sql
CHECK (
    severity IN (
        'INFO',
        'WARNING',
        'CRITICAL'
    )
)
```

### alert_status

```sql
CHECK (
    alert_status IN (
        'UNCONFIRMED',
        'ACKNOWLEDGED',
        'RESOLVED'
    )
)
```

### 이벤트 연결 제약

객체 위험, 경로 이탈, 운행 완료 중 정확히 하나만 연결한다.

```sql
CHECK (
    (
        detection_event_id IS NOT NULL
        AND route_deviation_id IS NULL
        AND trip_id IS NULL
    )
    OR
    (
        detection_event_id IS NULL
        AND route_deviation_id IS NOT NULL
        AND trip_id IS NULL
    )
    OR
    (
        detection_event_id IS NULL
        AND route_deviation_id IS NULL
        AND trip_id IS NOT NULL
    )
)
```

> **`operator_note` 설계 의도**: `alert_message`는 시스템이 알림 생성 시 자동으로 채우는 메시지(예: "보행자 근접 위험 발생")이고, `operator_note`는 관제사가 확인/처리 과정에서 남기는 자유 텍스트 코멘트(예: "현장 확인 결과 오탐, 조도 문제로 추정")로 용도를 분리했다. 한 alert당 메모가 1건이면 충분하다는 전제로 컬럼 하나로 단순화했다 — 관제사별로 메모가 여러 건 누적되어야 하는 요구가 생기면 별도의 `alert_note` 이력 테이블로 분리 검토가 필요하다.

> **`vehicle_id` 비정규화 유지 사유**: `alert.vehicle_id`는 `detection_event.vehicle_id` 또는 `route_deviation.vehicle_id`를 통해 항상 유도 가능한 값이라 이론적으로는 중복이다. 그럼에도 직접 컬럼으로 유지하는 이유는 다음과 같다.
>
> - **쿼리 단순성**: 이 컬럼이 없으면 "특정 차량의 알림 조회"(관제실 실시간 피드, 차량별 알림 이력, 예외기반 필터 등 핫 패스 쿼리) 시마다 `detection_event`/`route_deviation`을 각각 LEFT JOIN 하고 `COALESCE`로 합쳐야 한다. `WHERE vehicle_id = ?` 한 줄이면 될 조회가 조건부 이중 JOIN이 된다.
> - **인덱스 비용**: 컬럼이 있으면 `alert` 테이블 자체에 `(vehicle_id, created_at)` 인덱스를 걸어 차량별·시간순 스캔이 빠르다. 없으면 조인 대상 테이블의 인덱스와 옵티마이저의 조인 순서 선택에 의존해야 해 성능이 덜 예측 가능하다.
> - **안정성**: `COALESCE` 방식은 제약조건 위반이나 참조 무결성 예외 상황에서 조용히 NULL을 반환할 수 있다. 반면 직접 저장된 `vehicle_id`는 NOT NULL 제약으로 이상 상황을 즉시 드러낸다.
>
> `alert`는 생성 시점에 한 번만 값이 설정되고 이후 갱신되지 않으므로(write-once), 원본 값과 어긋날 위험(drift)은 없다. `detection_event`에 적용한 `vehicle_code`/`class_name` 비정규화와 동일한 논리이며, 제거 시 얻는 이점은 없고 조회 비용만 늘어나므로 유지한다.

> **쓰기 주체, 트리거 원인별 (v13)**: `alert`는 INSERT 주체가 갈리는 유일한 테이블이다. `detection_event_id`가 채워지는 비전 감지 기반 `OBJECT_PROXIMITY`는 FastAPI Vision service의 persistence path가 생성한다. `route_deviation_id`가 채워지는 경로 이탈과 `trip_id`가 채워지는 `TRIP_COMPLETED`는 Node가 생성한다. 어느 쪽이 생성했든 `acknowledged_by`/`operator_note`/`alert_status` UPDATE와 대시보드 알림 feed SELECT는 Node가 담당한다.

---

## 7.2 transport_goal (통계 전용, 최소 스펙)

> **범위 명시**: 이 테이블은 **통계/대시보드 화면에 배차 관련 수치를 표시**하기 위한 최소한의 스펙이다. 배차 추천 알고리즘, 계획 버전 관리, 계획-차량 매핑 등 실제 "배차 계획 수립" 기능(목업의 `dispatch.html` — 추천 배차안 생성, 계획 수정, 계획 확정)은 여전히 이 ERD 범위 밖이며, 이를 구현하려면 `dispatch_plan`, `dispatch_assignment`, `dispatch_assignment_goal` 등 별도 테이블이 필요하다.

운송 목표(배송 건) 하나를 하나의 행으로 저장한다. 배차 계획 수립 로직 없이, "목표가 존재하고 상태가 무엇이며 어느 차량/운행에 연결됐는가"만 표현한다.

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| `goal_id` | BIGSERIAL | PK | 운송 목표 ID |
| `goal_code` | VARCHAR(50) | UNIQUE, NOT NULL | JOB-001 등 |
| `destination_name` | VARCHAR(150) | NOT NULL | 목적지명 |
| `destination_address` | TEXT |  | 목적지 주소 |
| `destination_location` | geography(Point,4326) |  | 목적지 좌표 (v9, `latitude`/`longitude` 대체) |
| `cargo_weight_kg` | NUMERIC(10,2) |  | 화물 중량 |
| `priority` | VARCHAR(20) | NOT NULL | 우선순위 |
| `target_eta` | TIMESTAMPTZ |  | 목표 도착 시각 |
| `goal_status` | VARCHAR(30) | NOT NULL | 처리 상태 |
| `assigned_vehicle_id` | BIGINT | FK | 배정된 차량 (미배정 시 NULL) |
| `assigned_trip_id` | BIGINT | FK | 이 목표를 수행한 운행 (완료 후 연결) |
| `completed_at` | TIMESTAMPTZ |  | 완료 시각 |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() | 생성 시각 |
| `updated_at` | TIMESTAMPTZ | DEFAULT NOW() | 수정 시각 |

### priority

```sql
CHECK (
    priority IN (
        'HIGH',
        'NORMAL',
        'LOW'
    )
)
```

### goal_status

```sql
CHECK (
    goal_status IN (
        'PENDING',
        'ASSIGNED',
        'IN_PROGRESS',
        'COMPLETED',
        'DELAYED',
        'CANCELLED'
    )
)
```

> `DELAYED`는 `target_eta`가 지났는데 `goal_status`가 아직 `COMPLETED`가 아닌 경우를 배치job이나 조회 시점에 판단해 갱신하는 것을 권장한다 (트리거보다는 애플리케이션/배치 로직 권장 — 복잡도를 낮추기 위함).

### 통계 화면 매핑 예시

```text
운송 목표 진행률       → COMPLETED 건수 / 전체 건수
운송 목표 완료율        → COMPLETED 건수 / 전체 건수 (동일 로직, 표시만 다름)
운송목표 9건            → COUNT(*)
완료 7건                → COUNT(*) WHERE goal_status = 'COMPLETED'
진행 중 1건             → COUNT(*) WHERE goal_status = 'IN_PROGRESS'
지연 예상 1건            → COUNT(*) WHERE goal_status = 'DELAYED'
```

> "평균 경로 진행률"(현재 운행 차량 기준)은 `transport_goal`과 무관하게 `route.distance_m` 대비 주행한 거리(`vehicle_position` 누적 또는 `trip.actual_distance_m`)로 계산하는 일반 운행 지표이며, 이 테이블이 없어도 이미 계산 가능하다.

### 권장 인덱스

```sql
CREATE INDEX idx_transport_goal_status
ON transport_goal (
    goal_status,
    target_eta
);

CREATE INDEX idx_transport_goal_vehicle
ON transport_goal (
    assigned_vehicle_id
);

CREATE INDEX idx_transport_goal_location
ON transport_goal
USING GIST (destination_location);
```

---

# 8. 주요 관계 정리

## 8.1 차량

```text
Vehicle (카메라/캘리브레이션 정보 포함)
   │
   ├─ VehiclePosition
   │
   ├─ Trip
   │
   ├─ DetectionEvent
   │
   ├─ RouteDeviation
   │
   ├─ Alert
   │
   └─ TransportGoal (배정된 목표, 통계 전용)
```

---

## 8.2 운행

```text
Vehicle
   │
   ▼
Trip
   │
   ├─ Route
   │
   ├─ VehiclePosition
   │
   ├─ TripVideo
   │    └─ VideoTimeAnchor
   │
   ├─ FrameInference
   │
   ├─ DetectionEvent
   │
   ├─ RouteDeviation
   │
   └─ Alert (TRIP_COMPLETED)
```

---

## 8.3 비전 위험

```text
Vehicle (카메라 내장)
      │
      ▼
FrameInference (session_id + frame_id, capture_timestamp_ns, detections JSONB)
      │
      └─ selected risky/representative objects
             │
             ▼
DetectionEvent (session_id + frame_id + capture_timestamp_ns)
      │
      ├─ ObjectClass
      ├─ EventImage
      └─ Alert
```

---

## 8.4 경로 위험

```text
Route
  │
  ▼
RouteDeviation
  │
  ▼
Alert
```

---

# 9. 화면과 테이블 매핑

운송 목표 / 배차 계획 화면은 제외한다.

---

## 9.1 종합 관제 대시보드

주요 테이블:

- `vehicle`
- `vehicle_position`
- `trip`
- `route`
- `route_deviation`
- `alert`
- `transport_goal` (운송 목표 진행률/완료 건수 카드용)

표시 정보:

```text
운행 중 차량 수
위험 이벤트 수
미처리 경고 수
경로 이탈 횟수
차량 현재 위치
목적지
현재 운행 경로
실제 이동 경로
경로 이탈 위치
예상 도착 시간
실시간 이벤트 피드 (위험 알림 + 운행 완료를 alert.alert_type 기준으로 함께 시간순 표시)
운송 목표 진행률 / 운행 완료 차량 수 (transport_goal.goal_status 집계)
평균 경로 진행률 (transport_goal과 무관, route.distance_m 대비 주행거리로 계산)
```

---

### v15 클라이언트 bootstrap / 연결 순서

```text
Tauri → Node/Express : operator login
Node → Tauri         : JWT + Vision Service Address + permissions
Tauri → FastAPI Vision: authenticated gRPC subscription / vision calls

Android → Node/Express: device bootstrap
Node → Android        : Vision/Dashboard Service Address + device token + upload credential
Android → Tauri       : direct live frames
Android → FastAPI Vision: inference frames
```

Node가 endpoint discovery를 제공하므로 Tauri/Android에 특정 GPU host를 hard-code하지 않는다. live preview 자체는 bootstrap 완료 후에도 Node/FastAPI를 거치지 않는다.

---

## 9.2 실시간 차량 관제

주요 테이블:

- `vehicle` (카메라/캘리브레이션 정보 포함)
- `driver`
- `vehicle_position`
- `trip`
- `frame_inference` (historical/debug metadata; live overlay 자체는 gRPC로 직접 수신)
- `detection_event` (vehicle_code, class_name 비정규화 — 위험/대표 이벤트)

표시 정보:

```text
차량 ID
운전자
현재 위치
속도
목적지
실시간 카메라
탐지 객체
Confidence
객체 거리
위험 단계
```

---

## 9.3 위험 이벤트 관리

주요 테이블:

- `detection_event`
- `object_class`
- `event_image`
- `route_deviation`
- `alert`
- `vehicle`
- `platform_account`

표시 정보:

```text
발생 시각
차량
이벤트 유형
객체
Confidence
객체 거리
경로 이탈 거리
이벤트 이미지
경고 상태
확인 관제사
```

---

## 9.4 통계 분석

주요 테이블:

- `detection_event`
- `alert`
- `route_deviation`
- `trip`
- `vehicle`
- `transport_goal` (배차 관련 수치 — 통계 전용, 계획 수립 기능은 미포함)

분석 예시:

```text
일별 위험 이벤트 수
객체별 위험 발생 비율
차량별 위험 이벤트 수
평균 위험 거리
경로 이탈 횟수
평균 경로 이탈 거리
차량별 운행 거리
운행 완료 건수
운송 목표 수 / 완료 건수 / 진행 중 건수 / 지연 예상 건수
운송 목표 완료율
```

---

## 9.5 운행기록 재생 화면

최종 frame-sync architecture에 따라 live exact join과 replay timeline alignment를 분리한다.

주요 테이블:

- `trip_video` — Object Storage H.264 segment 위치
- `video_time_anchor` — `capture_timestamp_ns ↔ video_pts_us` mapping
- `frame_inference` — frame-level historical detection metadata
- `detection_event` — 위험/대표 이벤트 timeline marker
- `vehicle_position` — GPS replay
- `event_image`
- `trip` (`ai_summary` — 운행 요약)

### Replay sync 절차

```text
video player position (PTS)
        ↕
video_time_anchor
capture_timestamp_ns
        ↕
frame_inference / detection_event timeline
```

- exact frame identity가 필요한 경우 `session_id + frame_id`로 match한다.
- video seek/timeline alignment는 `frame_id / fps` 계산이 아니라 `capture_timestamp_ns ↔ video_pts_us` mapping을 사용한다.
- `started_at`, DB `created_at`, network arrival time은 replay sync key가 아니다.

표시 정보:

```text
운행 영상 재생
재생 시점의 GPS 위치
재생 시점의 탐지 객체/거리 overlay
이벤트 발생 지점 timeline marker
marker 클릭 시 해당 video PTS로 이동
운행 요약 (trip.ai_summary, 있는 경우)
```

---

# 10. 핵심 데이터 흐름

## 10.1 객체 접근 위험 / 실시간 비전

```text
Android CameraX
    │
    ├─ FrameEnvelope(session_id, frame_id, capture_timestamp_ns)
    │        ↓ gRPC inference
    │   GPU inference + post-processing
    │        │
    │        ├─ gRPC detections ───────────────► Tauri live view
    │        │                                  (session_id + frame_id exact join)
    │        │
    │        └─ enqueue metadata
    │              ↓
    │          bounded queue
    │              ↓
    │          async DB writer
    │              ↓ batch INSERT
    │          frame_inference
    │              ↓ selected risk/event
    │          detection_event
    │              ↓
    │          alert (필요 시)
    │
    └─ preview stream ─────────────────────────► Tauri live view
```

PostgreSQL persistence는 inference critical path 밖에 있으며 DB COMMIT 완료를 기다린 뒤 다음 frame을 처리하는 구조로 구현하지 않는다.

---

## 10.2 차량 위치 및 경로

```text
차량 GPS
    ↓
vehicle_position 저장
    ↓
현재 위치 업데이트
    ↓
trip의 현재 route와 비교
    ↓
대시보드 지도 갱신
```

---

## 10.3 경로 이탈

```text
vehicle_position 수신
        ↓
현재 route와 비교
        ↓
이탈 거리 계산
        ↓
기준 이상 이탈
        ↓
route_deviation 저장
        ↓
alert 생성
        ↓
OSRM / A* 경로 재탐색
        ↓
새 route 저장
        ↓
이전 route.is_current = FALSE
        ↓
새 route.is_current = TRUE
        ↓
대시보드 경로 갱신
```

---

## 10.4 영상 저장 및 재생 동기화

```text
Android Local H.264 Encoder
    │
    ├─ H.264 segment ─────────► Object Storage
    │
    └─ encoder time anchors
           capture_timestamp_ns ↔ video_pts_us
                    │
                    ▼
             video_time_anchor

Replay:
Object Storage H.264 + video_time_anchor + frame_inference/detection_event
                    │
                    ▼
              Tauri Replay View
```

`trip_video.start_frame_id`와 `fps`는 범위/diagnostic metadata로 유지하지만, 실제 replay alignment의 source of truth는 `video_time_anchor`다.

---

# 11. 권장 인덱스

## frame_inference

```sql
CREATE INDEX idx_frame_inference_trip_capture
ON frame_inference (
    trip_id,
    capture_timestamp_ns
);

CREATE INDEX idx_frame_inference_vehicle_capture
ON frame_inference (
    vehicle_id,
    capture_timestamp_ns
);
```

---

## video_time_anchor

```sql
CREATE INDEX idx_video_time_anchor_capture
ON video_time_anchor (
    session_id,
    capture_timestamp_ns
);

CREATE INDEX idx_video_time_anchor_pts
ON video_time_anchor (
    trip_video_id,
    video_pts_us
);
```

---

## vehicle_position

```sql
CREATE INDEX idx_vehicle_position_vehicle_time
ON vehicle_position (
    vehicle_id,
    recorded_at DESC
);
```

---

## detection_event

```sql
CREATE INDEX idx_detection_event_frame
ON detection_event (
    session_id,
    frame_id
);

CREATE INDEX idx_detection_event_trip_capture
ON detection_event (
    trip_id,
    capture_timestamp_ns
);

CREATE INDEX idx_detection_event_vehicle_time
ON detection_event (
    vehicle_id,
    detected_at DESC
);

CREATE INDEX idx_detection_event_class_time
ON detection_event (
    class_id,
    detected_at DESC
);

CREATE INDEX idx_detection_event_risk_time
ON detection_event (
    risk_level,
    detected_at DESC
);
```

---

## alert

```sql
CREATE INDEX idx_alert_status_created
ON alert (
    alert_status,
    created_at DESC
);

CREATE INDEX idx_alert_vehicle_created
ON alert (
    vehicle_id,
    created_at DESC
);

CREATE INDEX idx_alert_type_created
ON alert (
    alert_type,
    created_at DESC
);
```

---

## route

```sql
CREATE INDEX idx_route_trip_current
ON route (
    trip_id,
    is_current
);
```

---

## route_deviation

```sql
CREATE INDEX idx_route_deviation_trip_time
ON route_deviation (
    trip_id,
    detected_at DESC
);
```

---

## 공간 인덱스 (PostGIS GiST, v8)

각 테이블 정의부에 개별적으로 기재되어 있는 GiST 인덱스를 한 곳에 모았다.

```sql
CREATE INDEX idx_vehicle_position_location
ON vehicle_position USING GIST (location);

CREATE INDEX idx_route_deviation_location
ON route_deviation USING GIST (location);

CREATE INDEX idx_detection_event_location
ON detection_event USING GIST (location);

CREATE INDEX idx_route_line
ON route USING GIST (route_line);

CREATE INDEX idx_transport_goal_location
ON transport_goal USING GIST (destination_location);
```

> `trip.origin_location`/`trip.destination_location`는 트립 단위 point-in-radius 검색 요구가 아직 없어 GiST 인덱스는 생략 (필요해지면 추가).

---

# 12. MVP 구현 우선순위

## 1단계 — 차량 / 비전 위험 이벤트

```text
vehicle (카메라/캘리브레이션 포함)
object_class
frame_inference (frame-level metadata)
detection_event (위험/대표 이벤트)
event_image
alert
```

구현 가능한 기능:

- 차량 실시간 영상
- YOLO 객체 탐지
- Confidence 표시
- 객체 거리 측정
- 위험 이벤트 생성
- 위험 이벤트 조회
- 관제사 확인 처리

---

## 2단계 — 실제 운행

```text
driver
trip
trip_video
video_time_anchor
vehicle_position
```

추가 기능:

- 운전자 표시
- 차량 현재 위치
- 차량 속도
- 출발지 / 목적지
- 실제 이동 경로
- H.264 운행 영상 등록/재생
- `capture_timestamp_ns ↔ video_pts_us` 기반 replay alignment

---

## 3단계 — 경로 관제

```text
route
route_deviation
```

추가 기능:

- 최적 경로 표시
- 경로 이탈 감지
- 이탈 경고
- 경로 재탐색
- 경로 변경 이력

---

## 4단계 — 운송 목표 통계 (선택)

```text
transport_goal
```

추가 기능:

- 운송 목표 등록/상태 표시 (배차 계획·추천 로직 없이 상태값만 관리)
- 대시보드/통계 화면의 배차 관련 수치 (목표 수, 완료율, 진행 중/지연 건수)

> 배차 추천·계획 확정 등 실제 계획 수립 UI(목업 `dispatch.html`)를 구현하려면 이 단계로도 부족하며, `dispatch_plan`/`dispatch_assignment`/`dispatch_assignment_goal`을 별도로 추가해야 한다.

---

# 13. 최종 핵심 구조

```text
[차량]

Vehicle
   │
   ├─ Driver
   ├─ VehiclePosition
   └─ Trip


[운행 / 경로]

Trip
 │
 ├─ Route
 │    │
 │    └─ RouteDeviation
 │
 ├─ VehiclePosition
 │
 └─ TripVideo
      └─ VideoTimeAnchor


[비전]

Vehicle (카메라 내장)
     │
     ▼
FrameInference (session_id + frame_id, capture_timestamp_ns, detections JSONB)
     │
     └─ DetectionEvent (위험/대표 이벤트)
            │
            ├─ ObjectClass (FK 유지, 조회 시 JOIN 불필요)
            └─ EventImage


[관제 경고]

DetectionEvent ──┐
RouteDeviation ──┼── Alert
Trip (완료) ──────┘
                    │
                    ▼
               PlatformAccount
```

---

# 14. 최종 테이블 수

총 **15개 테이블**로 구성한다. v13에서 최종 frame-sync architecture를 구현하기 위해 `frame_inference`, `video_time_anchor` 두 테이블을 추가했다. v14는 async persistence 구현 규칙을 명확히 했고, v15는 Node/Express auth/control plane과 FastAPI Vision + GPU service boundary 및 bootstrap/service-discovery flow를 확정한 것으로 **schema table 수 변화는 없다.**

```text
1. platform_account
2. vehicle (카메라/캘리브레이션 통합)
3. driver
4. trip (origin_location, destination_location, ai_summary 포함)
5. trip_video (session_id, segment_index 포함)
6. video_time_anchor (capture_timestamp_ns ↔ video_pts_us)
7. route (route_line 포함)
8. vehicle_position (location 포함)
9. route_deviation (location 포함)
10. object_class
11. frame_inference (session_id + frame_id composite PK, detections JSONB, model_version, inference_ms)
12. detection_event (session_id, frame_id, capture_timestamp_ns, model_version, track_id 및 기존 위험 이벤트 정보)
13. event_image
14. alert (trip_id, operator_note 포함)
15. transport_goal (통계 전용, destination_location 포함, 배차 계획 기능 미포함)
```

---

# 15. 설계 요약

본 ERD는 크게 다음 다섯 영역으로 나뉜다.

### 1. 차량 관리

```text
vehicle (카메라/캘리브레이션 통합)
driver
```

### 2. 운행 및 위치

```text
trip
trip_video
video_time_anchor
vehicle_position
```

### 3. 경로 관제

```text
route
route_deviation
```

### 4. AI 위험 감지 및 관제

```text
object_class
frame_inference
detection_event
event_image
alert
platform_account
```

### 5. 운송 목표 (통계 전용)

```text
transport_goal
```

기존 설계에 포함되어 있던 다음 항목은 여전히 제거된 상태이다 (배차 계획 수립 기능 자체).

```text
dispatch_plan
dispatch_assignment
dispatch_assignment_goal
```

> `transport_goal`은 v6에서 통계 화면 지원 목적으로 예외적으로 복원되었으나, 배차 추천 알고리즘·계획 버전 관리·계획-차량 매핑 기능은 위 세 테이블 없이는 구현할 수 없으므로 여전히 범위 밖이다.

따라서 본 설계는 **차량 운행 → 위치 및 경로 관제 → frame-synchronized AI inference → 비동기 metadata 영속화 → 위험 경고 → 영상/탐지 replay 정렬 → 이벤트 저장 및 분석 (+ 운송 목표 통계)**에 집중한 구조이다.

주요 변경 사항:
- `vehicle_camera` 테이블 제거 — 차량당 카메라 1대 전제이므로 카메라/캘리브레이션 정보를 `vehicle`에 통합.
- `detection_event`에 `vehicle_code`, `class_name`, `display_name`, `warning_distance_m` 비정규화 — 조회 빈도가 높은 핵심 테이블에서 JOIN을 제거하여 이벤트 로그, 재생, 통계 등 대부분의 화면에서 단일 테이블 스캔으로 처리.
- `detection_event`의 frame identity를 `session_id + frame_id`로 확장하고 `capture_timestamp_ns`를 추가 — session restart 후 frame ID 재사용을 안전하게 처리하고 source camera timeline을 보존.
- `trip_video` 테이블 신규 추가 — `event_image`는 위험 이벤트 순간의 스냅샷만 저장하므로, 운행기록 재생 화면에 필요한 연속 구간 영상 자체에 대한 참조가 없었던 누락을 보완.
- `VEHICLE ||--o{ ALERT` 관계 라벨을 `receives` → `concerns`로 수정 — 차량이 알림을 수신(push)하는 경로는 스키마에 없으므로, 차량이 경고의 "대상"일 뿐임을 정확히 반영.
- `alert`에 `trip_id`, `operator_note` 추가 — 운행 완료 이벤트를 알림 피드에 포함하고, 관제사 메모를 저장할 수 있도록 보완.
- 위치 텍스트(주소/지명)는 스키마에 저장하지 않고 화면 렌더링 시점에 역지오코딩 API로 변환하기로 결정.
- `transport_goal` 신규 추가 — 통계 화면의 배차 관련 수치(운송 목표 수, 완료율 등) 표시를 위한 최소 스펙. 배차 계획 수립 기능 자체는 여전히 제외.
- `trip`에 `ai_summary`, `ai_summary_generated_at` 추가 — LLM 운행 요약(고도화 F) 결과를 저장할 곳이 없던 누락을 보완.
- **PostGIS extension 채택 (v8)** — `vehicle_position`/`route_deviation`/`detection_event`/`trip`/`transport_goal`에 `geography(Point, 4326)` 컬럼을, `route`에 `route_line geography(LineString, 4326)`을 추가해 경로 이탈 거리 계산(`ST_Distance`)과 근접 조회(`ST_DWithin`)를 정확하고 빠르게 처리할 수 있게 됨.
- **`latitude`/`longitude` 완전 제거 (v9)** — v8에서는 기존 위경도 컬럼을 유지한 채 PostGIS 생성 컬럼을 병행했으나, v9에서 위경도 컬럼을 제거하고 PostGIS `geography` 컬럼을 유일한 위치 저장 방식으로 단일화. 조회 시 위경도 숫자가 필요하면 `ST_Y`/`ST_X`로 추출.
- **Node 데이터 액세스 경계 규칙 (v10, v13에서 확장)** — Node의 일반 CRUD는 Prisma Client, PostGIS 연산이 관여하는 쿼리는 TypedSQL/`$queryRaw`를 사용한다. v13부터 FastAPI Vision service의 고빈도 writer는 이 Node 규칙과 별도로 async/batched writer를 사용한다.
- **`detection_event`에 캡처 순간 IMU 스냅샷 추가 (v11)** — `pitch_at_capture_deg`/`roll_at_capture_deg`/`telemetry_source`를 추가해, 알럿 리플레이 화면에서 거리 계산에 실제로 쓰인 순간 pitch/roll을 사후 감사할 수 있게 함. 별도 고빈도 IMU 테이블(`frame_telemetry`)은 소비처가 없어 채택하지 않음.
- **v12 서비스 분리안은 v13 최종 architecture로 대체됨** — 과거 FastAPI frame ingest/relay 경로는 변경 이력으로만 남기며 현재 구현 기준이 아니다.
- **최종 frame-sync architecture 반영 (v13)** — Android가 `session_id + frame_id + capture_timestamp_ns`의 원본이며 GPU/Tauri가 이를 그대로 전달한다. `frame_inference`를 추가해 frame-level detections JSONB/model version/inference latency를 보존하고, `video_time_anchor`를 추가해 `capture_timestamp_ns ↔ video_pts_us` 기반 replay를 구현한다.
- **GPU → PostgreSQL async persistence 규칙 확정 (v14)** — post-processing은 bounded in-process queue에 enqueue하고 dedicated async writer가 batch INSERT한다. DB COMMIT은 inference critical path에 포함하지 않으며 queue/worker는 high-level architecture diagram에 표시하지 않는 내부 구현 상세다.
- **Node control plane / FastAPI Vision plane 확정 (v15)** — Node/Express가 operator auth, RBAC, JWT 발급, bootstrap/service discovery와 일반 business/history API를 소유한다. auth/bootstrap 응답은 JWT와 함께 Vision Service Address(endpoint descriptor)를 반환한다. FastAPI Vision Service는 FastAPI HTTP + gRPC server + GPU model을 하나의 배포 단위로 운용하며 Node-issued credential을 검증한다. Android→Tauri live preview는 두 backend를 모두 우회하고, Tauri는 DB에 직접 연결하지 않고 Node API로 history/replay metadata를 조회한다.

PostgreSQL의 `ENUM TYPE`은 사용하지 않으며 상태값은 모두 `VARCHAR + CHECK` 제약조건으로 관리한다.
