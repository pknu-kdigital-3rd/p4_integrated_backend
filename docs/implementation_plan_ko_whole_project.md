> 이전 v15 계획 문서입니다. 현재 ITS 통합 내용은 `v18_its_integrated_erd.md` 및 루트 `README.md`를 참조하십시오.

# 차량 지능형 위험 감지 및 경로 관제 플랫폼
## 전체 프로젝트 구현 계획 — v15 아키텍처 기준

**문서 유형:** 프로젝트 비전, 시스템 설계, 구현 로드맵, 통합 계약
**상태:** 구현 기준선
**아키텍처 버전:** v15 서비스 소유권 + 최신 아키텍처 다이어그램
**주요 목표:** 카메라 기반 위험 감지, 차량/경로 관제, 실시간 관제 화면, 운행 영상 재생, 공간 기반 이벤트 이력, 운영 통계를 하나의 시스템으로 통합하되, 고빈도 비전 처리 경로와 일반 업무/관제 백엔드 경로를 분리한다.

---

# 1. 문서 목적

이 문서는 프로젝트 전체를 구현하기 위한 상위 기준 문서다. 개별 서비스의 세부 구현은 FastAPI Vision Service 문서와 Node/Express Control Backend 문서에서 다루지만, 두 서비스와 Android, Tauri, PostgreSQL/PostGIS, Object Storage, AI 모델 개발이 어떤 하나의 제품을 구성하는지에 대한 기준은 본 문서가 제공한다.

이 프로젝트는 단순한 YOLO 객체 탐지 데모도 아니고, 단순한 차량 CRUD 시스템도 아니다. 다음 다섯 가지 영역이 하나의 시간축과 하나의 데이터 모델 안에서 연결되어야 한다.

1. **차량 측 센싱 및 녹화** — Android/CameraX가 카메라 프레임, 프레임 식별자, 원본 캡처 시간, 로컬 H.264 녹화의 기준점이 된다.
2. **AI/비전 처리** — GPU 기반 FastAPI Vision Service가 gRPC로 추론 프레임을 받아 탐지, 거리 추정, 위험 판단, 실시간 탐지 결과 전송, 비동기 영속화를 담당한다.
3. **관제/업무 처리** — Node/Express가 인증, RBAC, 차량/운전자/운행/경로/GPS/경로 이탈/알림/통계/history/replay metadata를 담당한다.
4. **운영자 경험** — Tauri Dashboard가 Android 프레임과 FastAPI 탐지 결과를 직접 수신하여 실시간 화면을 구성하고, 과거 운행을 동기화 재생한다.
5. **영구 기록** — PostgreSQL/PostGIS가 업무 상태, 공간 이력, 추론 메타데이터, 위험 이벤트를 저장하고 Object Storage가 H.264 및 이벤트 이미지를 저장한다.

핵심 설계 원칙은 다음과 같다.

- 실시간 영상은 Node/Express를 경유하지 않는다.
- 추론 처리는 DB COMMIT을 기다리지 않는다.
- Tauri 실시간 화면은 프레임마다 PostgreSQL을 조회하지 않는다.
- 프레임 동기화는 네트워크 도착 순서가 아니라 `session_id + frame_id`를 사용한다.
- 재생 동기화는 `frame_id / fps`가 아니라 `capture_timestamp_ns ↔ video_pts_us` time anchor를 사용한다.

---

# 2. 제품 비전

최종 시스템에서 관제자는 하나의 Tauri 애플리케이션을 통해 다음 질문에 답할 수 있어야 한다.

- 현재 각 차량은 어디에 있는가?
- 현재 운행은 어떤 경로를 따라야 하는가?
- 차량이 경로에서 이탈했는가? 이탈 거리는 얼마인가?
- 차량 카메라는 현재 무엇을 보고 있는가?
- 어떤 객체가 탐지되었으며, 차량과의 거리와 위험 수준은 무엇인가?
- 어떤 탐지 결과가 실제 위험 이벤트 또는 알림으로 남았는가?
- 특정 시각 또는 특정 위치에서 과거에 무엇이 발생했는가?
- 녹화 영상, 탐지 결과, GPS 위치, 이벤트 마커를 동일한 시간축으로 재생할 수 있는가?
- 차량/운행별 위험 패턴과 운영 통계를 확인할 수 있는가?
- 운행 종료 후 구조화된 사실을 기반으로 AI 요약을 생성할 수 있는가?

제품의 핵심 가치는 **실시간 AI + 공간 관제 + 동기화 재생 + 감사 가능한 이력**의 통합이다.

---

# 3. 프로젝트 범위

## 3.1 Android 차량 애플리케이션

구현 범위:

- CameraX 기반 카메라 캡처.
- 카메라/추론 세션 단위 `session_id` 생성.
- 세션 내부에서 단조 증가하는 `frame_id` 생성.
- monotonic clock 기반 `capture_timestamp_ns` 부여.
- 추론용 프레임을 FastAPI Vision에 gRPC로 전송.
- 실시간 미리보기 프레임을 Tauri에 직접 gRPC로 전송.
- 로컬 H.264 인코딩 및 `video_pts_us` 확보.
- 녹화 segment를 Object Storage에 업로드.
- `trip_video` 및 `video_time_anchor` 관련 메타데이터를 Node에 전달.
- GPS/속도/방향 등 차량 telemetry를 Node에 전달.
- Node를 통한 device bootstrap 및 service discovery.

### 프레임 분기 원칙

한 카메라 프레임을 하나의 직렬 처리 체인에 넣지 않는다.

```text
CameraX frame
   ├── inference branch ─────────────► FastAPI gRPC
   ├── live preview branch ──────────► Tauri gRPC
   └── recording branch ─────────────► H.264 encoder ─► Object Storage
```

각 branch는 독립적인 backpressure 정책을 가져야 한다.

- 추론이 늦어져도 녹화 timestamp가 깨지면 안 된다.
- Object Storage 업로드가 늦어져도 실시간 화면이 멈추면 안 된다.
- Tauri 화면이 잠시 느려져도 추론 입력 queue가 무한 증가하면 안 된다.

## 3.2 AI / Vision

구현 범위:

- 객체 탐지용 데이터셋 설계/정제/버전 관리.
- 모델 학습 및 검증.
- inference artifact export 및 runtime model versioning.
- GPU inference.
- detection post-processing.
- 필요 시 short-term tracking.
- 카메라 calibration 및 순간 pitch/roll을 이용한 거리 추정.
- class별 threshold를 이용한 risk level 결정.
- Tauri로 실시간 detection 전송.
- `frame_inference` 비동기 저장.
- 중요 위험 탐지를 `detection_event`로 저장.
- 이벤트 snapshot을 Object Storage에 저장.
- 조건 충족 시 vision-origin `alert` 생성.

## 3.3 Node/Express Control / Business Backend

구현 범위:

- operator authentication.
- RBAC.
- JWT/token 발급.
- Android/Tauri bootstrap 및 service discovery.
- vehicle/driver/trip 관리.
- GPS 위치 저장 및 조회.
- route 생성/버전 관리.
- route deviation 계산.
- rerouting workflow.
- alert 조회/확인/메모/상태 관리.
- object class 정책 관리.
- transport goal 통계.
- trip video metadata/time anchor 관리.
- history/replay API.
- Object Storage presigned upload/download 권한 발급.
- Prisma Migrate를 통한 schema migration 단일 소유권.

## 3.4 Tauri Dashboard

구현 범위:

- operator login.
- Android direct live frame 수신.
- FastAPI detection stream 수신.
- `(session_id, frame_id)` 기반 exact join.
- bounding box, class, distance, risk overlay.
- 현재 차량/경로/GPS/이탈/알림 UI.
- history/event 조회.
- Object Storage Range GET 기반 replay.
- `video_pts_us ↔ capture_timestamp_ns` 기반 GPS/detection overlay 동기화.

## 3.5 Data Platform

- PostgreSQL + PostGIS.
- Prisma schema + migration.
- Object Storage.
- 고빈도 위치/추론 데이터 인덱스.
- backup/restore 및 retention policy.

## 3.6 기준선에서 명시적으로 제외하는 범위

- full fleet dispatch optimizer.
- `dispatch_plan`/`dispatch_assignment` 기반 복잡한 배차 계획 버전 관리.
- Tauri 또는 Android의 PostgreSQL 직접 접속.
- Node를 통한 실시간 영상 relay.
- Node에 두 번째 Vision gRPC server 구성.
- inference critical path에서 DB COMMIT 대기.
- 네트워크 arrival time 기반 프레임 동기화.
- LLM 요약을 사실 기록의 source of truth로 사용.

`transport_goal`은 통계/진척도 표시를 위한 최소 기능으로 유지한다.

---

# 4. 전체 아키텍처 원칙

## 4.1 3-Plane 구조

```text
MEDIA PLANE
Android  ── direct gRPC live frames ───────────────────────► Tauri
Android  ── H.264 PUT ─────────────────────────────────────► Object Storage
Tauri    ◄─ presigned HTTP Range GET ────────────────────── Object Storage

VISION PLANE
Android  ── gRPC FrameEnvelope ────────────────────────────► FastAPI Vision + GPU
FastAPI  ── gRPC detections ───────────────────────────────► Tauri
FastAPI  ── async/batched metadata ────────────────────────► PostgreSQL
FastAPI  ── event images ──────────────────────────────────► Object Storage

CONTROL / BUSINESS PLANE
Android  ── HTTPS bootstrap / telemetry ───────────────────► Node / Express
Tauri    ◄─► HTTPS REST auth/business/history/replay ──────► Node / Express
Node     ── business/spatial queries ──────────────────────► PostgreSQL
Node     ── media authorization ───────────────────────────► Object Storage
FastAPI  ◄─ low-rate vision context refresh ─────────────── Node / Express
```

최상위 아키텍처 다이어그램에서는 시각적 복잡도를 줄이기 위해 `FastAPI → Object Storage event image`와 `Node → FastAPI vision context refresh`를 생략할 수 있다. 그러나 실제 구현/테스트 기준에서는 반드시 존재한다.

## 4.2 책임 소유권

| 영역 | 기준 소유자 |
|---|---|
| Operator auth / RBAC | Node/Express |
| JWT/token issuance | Node/Express |
| Service discovery | Node/Express |
| 실제 Vision gRPC endpoint | FastAPI Vision Service |
| 카메라 frame identity | Android |
| live video bytes | Android → Tauri |
| Vision detections | FastAPI Vision |
| Business/history/replay API | Node/Express |
| DB schema migration | Prisma Migrate |
| Vision runtime DB write | FastAPI — 허용된 write set만 |
| H.264/event images | Object Storage |
| Live overlay composition | Tauri |
| Replay metadata aggregation | Node/Express |

## 4.3 동기화 불변조건

- 정확한 프레임 identity: `session_id + frame_id`.
- capture source timeline: `capture_timestamp_ns`.
- video timeline: `video_pts_us`.
- replay mapping: `video_time_anchor`의 `capture_timestamp_ns ↔ video_pts_us`.
- live join: `(session_id, frame_id)` exact match.
- network arrival time: 진단용 값일 뿐 synchronization key가 아니다.
- `fps`, `start_frame_id`: diagnostic/range metadata이며 replay 기준이 아니다.

---

# 5. 주요 시스템 컴포넌트

## 5.1 Android

Android는 frame identity의 원본이다. camera/inference session이 재시작되어 frame numbering을 다시 시작할 가능성이 있으면 새로운 `session_id`를 생성해야 한다.

### 구현 시 고려사항

- frame counter는 세션 내에서 monotonic 증가.
- `capture_timestamp_ns`는 wall clock이 아니라 monotonic source 사용.
- inference FPS와 live preview FPS는 동일할 필요가 없다.
- inference sampler가 stale frame을 버릴 수 있어야 한다.
- recording branch는 프레임 drop이나 backend 상태와 독립적으로 PTS를 유지한다.
- 업로드 실패 시 로컬 임시 파일/segment 상태를 관리한다.
- bootstrap 결과에서 `Vision Service Address`, dashboard endpoint, upload credential 등을 받는다.

## 5.2 FastAPI Vision Service

FastAPI Vision은 일반 업무 백엔드가 아니라 **운영 AI 서비스**다.

배포 단위에는 다음이 포함된다.

- FastAPI HTTP health/readiness/status.
- gRPC server.
- GPU model.
- preprocess/inference/postprocess.
- optional tracker.
- distance/risk logic.
- Node-issued credential validation.
- calibration/policy/active-trip cache.
- Tauri detection output.
- bounded persistence queue.
- vision DB writer.
- event image storage client.

## 5.3 Node/Express

Node는 control/business authority다.

- `system_user` 기반 operator auth.
- RBAC.
- service bootstrap/discovery.
- vehicle/driver/trip/route/GPS/alert/statistics.
- route deviation + reroute.
- object class warning policy.
- trip video/time anchor metadata.
- replay/history APIs.
- Object Storage authorization.
- migration ownership.

## 5.4 Tauri Dashboard

### Live View

- Android live frame 수신.
- FastAPI detection 수신.
- 짧고 bounded한 buffer를 `(session_id, frame_id)`로 관리.
- 일치하는 frame/detection만 결합.
- 오래된 unmatched frame/detection은 제거.
- overlay latency 및 join 실패율을 metric으로 남김.

### Business View

- Node REST로 vehicles/trips/routes/alerts/statistics/history 조회.
- DB 직접 연결 금지.

### Replay

- Node에 replay window metadata 요청.
- Node가 반환한 presigned URL로 Object Storage Range GET.
- Node API로 GPS, frame inference, detection event, time anchor 조회.
- playback PTS를 capture time으로 변환하여 overlay/GPS를 선택.

## 5.5 PostgreSQL/PostGIS

- 물리적으로는 하나의 shared DB.
- migration authority는 Node/Prisma.
- Node는 대부분 business read/write 담당.
- FastAPI는 문서에 명시된 vision write만 수행.
- 위치 데이터는 `geography(Point, 4326)` 단일 소스.
- route spatial data는 `geography(LineString, 4326)`.
- Prisma가 직접 표현하지 못하는 GIS 연산은 TypedSQL/raw SQL 사용.

## 5.6 Object Storage

DB에는 binary 자체를 저장하지 않고 object key/URL/metadata만 저장한다.

주요 object:

- H.264/video segments.
- event snapshot images.
- 필요 시 replay용 remux 결과.

---

# 6. AI / Vision 개발 프로그램

AI는 전체 프로젝트의 핵심 workstream이지만 독립 제품이 아니다. 모델 개발은 runtime contract와 운영 요구를 중심으로 진행해야 한다.

## 6.1 AI 목표

기준선 모델은 다음을 만족해야 한다.

1. 정의된 차량/도로/작업환경 관련 object class 탐지.
2. confidence 및 bounding geometry 제공.
3. 안정적인 위험 판단이 필요한 경우 short-term tracking 지원.
4. calibration 및 순간 telemetry를 이용한 거리 추정.
5. class/policy threshold에 따른 `NORMAL / WARNING / DANGER` 분류.
6. UI와 영속화에 모두 사용할 수 있는 deterministic machine-readable output 제공.
7. 모든 저장된 inference/event에 `model_version` 연결.

## 6.2 데이터셋 관리

이미지 폴더만 관리하지 말고 dataset manifest를 유지한다.

필수 항목:

- dataset version.
- source/license.
- class map/version.
- train/validation/test split.
- resolution distribution.
- day/night/weather/indoor/outdoor 등 환경 분포.
- negative/background subset.
- annotation tool/version.
- preprocessing/augmentation config.

안전 관련 시스템에서는 false positive도 운영자를 피로하게 하므로 hard negative 평가를 반드시 포함한다.

## 6.3 모델 개발 lifecycle

```text
Dataset Version
   ↓
Training Config + Code Commit
   ↓
Checkpoint / Export Artifact
   ↓
Offline Evaluation
   ↓
Latency + VRAM Benchmark
   ↓
Candidate Model Manifest
   ↓
Staging FastAPI Deployment
   ↓
Recorded Trip Replay Evaluation
   ↓
Approved Runtime Model Version
```

전체 mAP만 높다고 배포하지 않는다. 다음을 함께 본다.

- class별 precision/recall.
- critical class recall.
- negative video false positive rate.
- latency.
- VRAM.
- persistence/event 품질.
- 실제 replay scenario에서의 alert noise.

## 6.4 Runtime Model Contract

예시:

```yaml
model_version: hazard-yolo-2026-09-01-a
artifact: model.engine
input_width: 960
input_height: 544
class_map_version: 4
preprocess_version: 3
postprocess_version: 6
confidence_profile: default-v2
calibration_contract_version: 1
```

과거 결과를 설명할 수 있도록 `model_version`, inference latency, policy snapshot을 저장한다.

## 6.5 거리 추정 및 위험 판단

confidence만으로 danger를 결정하지 않는다.

입력 요소:

- detected class.
- confidence.
- bbox/image geometry.
- camera calibration.
- capture 시 pitch/roll.
- estimated distance.
- class-specific threshold.
- temporal persistence/track 정보.

`detection_event`에는 사후 감사에 필요한 capture-time pitch/roll/telemetry source를 가능한 범위에서 보존한다.

## 6.6 AI 평가 계층

### 모델 수준

- class별 precision/recall.
- mAP50, mAP50-95.
- confusion matrix.
- negative video의 false positives/min.
- danger class recall.
- 거리 추정 ground truth가 있으면 MAE/RMSE.

### 파이프라인 수준

- preprocess latency.
- GPU inference latency.
- postprocess latency.
- gRPC end-to-end latency.
- inference sampling/drop count.
- persistence queue depth/drop.
- detection-to-display latency.

### 제품 수준

- persisted event precision.
- curated replay scenario에서의 event recall.
- alert noise per trip/hour.
- live overlay synchronization accuracy.
- replay synchronization accuracy.

## 6.7 선택 기능: LLM 운행 요약

`trip.ai_summary`는 구조화된 event pipeline이 안정된 이후의 enhancement다.

입력은 다음처럼 제한한다.

- trip metadata.
- route deviations.
- alerts/detection count.
- significant timestamps.
- duration/distance.

LLM은 기존 기록을 요약할 뿐 새로운 이벤트를 생성하지 않는다. DB 구조화 데이터가 항상 authoritative source다.

---

# 7. DB 및 ERD 전략

상세 스키마는 별도 **v16 ERD 문서**를 기준으로 한다.

핵심 규칙:

- baseline table 수: 15.
- schema migration: Prisma Migrate only.
- 상태값: PostgreSQL ENUM 대신 `VARCHAR + CHECK`.
- 일반 시간: `TIMESTAMPTZ`.
- monotonic capture/PTS: `BIGINT`.
- 위치: PostGIS `geography(Point, 4326)` only.
- route line: `geography(LineString, 4326)`.
- `frame_inference` PK: `(session_id, frame_id)`.
- media binary는 Object Storage.
- replay/GPS/high-frequency inference에 time-window index 필수.

ERD는 단순 저장 구조가 아니라 cross-service contract다.

---

# 8. 주요 End-to-End Flow

## 8.1 Startup / Bootstrap

1. Android/Tauri가 Node HTTPS endpoint 호출.
2. Node가 user/device 인증.
3. token/credential + service descriptor 반환.
4. descriptor에 **Vision Service Address** 포함.
5. 실제 Vision gRPC endpoint는 FastAPI가 소유.
6. client는 FastAPI에 직접 연결.

## 8.2 Live Inference / Display

1. Android frame capture.
2. `(session_id, frame_id, capture_timestamp_ns)` 부여.
3. inference payload → FastAPI.
4. decode/preprocess/GPU inference.
5. postprocess/distance/risk.
6. detection → Tauri 즉시 전송.
7. persistence envelope → bounded queue enqueue.
8. Tauri가 Android live frame과 exact join.

## 8.3 Vision Event Persistence

1. 보존 정책에 따라 `frame_inference` 생성.
2. 중요 risk detection → `detection_event`.
3. 필요 시 snapshot → Object Storage + `event_image`.
4. policy 조건 충족 → vision-origin `alert`.
5. background DB writer가 batch INSERT/COMMIT.
6. critical event는 ordinary frame telemetry보다 높은 persistence priority.

## 8.4 GPS / Route Deviation

1. Android GPS → Node.
2. `vehicle_position` PostGIS 저장.
3. active trip/current route 확인.
4. `ST_Distance` 기반 point-to-route 거리 계산.
5. threshold 초과 시 `route_deviation` + alert.
6. OSRM/A* reroute.
7. 새 route version 저장 및 `is_current` 변경.
8. Tauri가 Node에서 state 갱신.

## 8.5 Recording / Replay

1. Android local H.264 encoding.
2. segment → Object Storage.
3. `trip_video` metadata + `video_time_anchor` → Node.
4. Node DB 저장.
5. Tauri가 bounded replay window 요청.
6. Node가 media authorization + metadata 반환.
7. Tauri가 Object Storage Range GET.
8. `video_pts_us ↔ capture_timestamp_ns`로 GPS/detection/event overlay.

---

# 9. API 및 Protocol Contract

## 9.1 Node Public REST

```text
/auth/*
/bootstrap/*
/vehicles/*
/drivers/*
/trips/*
/routes/*
/telemetry/*
/alerts/*
/object-classes/*
/transport-goals/*
/history/*
/replay/*
/statistics/*
```

Zod schema를 runtime validation과 OpenAPI 생성에 공동 사용한다.

## 9.2 Node Internal API

FastAPI가 매 frame마다 Node를 호출하지 않도록 저빈도 context API를 제공한다.

```text
GET /internal/vehicles/{vehicleId}/vision-context
```

응답 예:

- camera calibration.
- active trip id.
- object class thresholds.
- policy version.
- config updated_at/version.

FastAPI는 TTL/version 기반 cache를 사용한다.

## 9.3 Vision gRPC

대표 개념:

```text
FrameEnvelope
- protocol_version
- session_id
- frame_id
- capture_timestamp_ns
- vehicle_id
- encoded image
- source dimensions
- optional telemetry

DetectionFrame
- protocol_version
- session_id
- frame_id
- capture_timestamp_ns
- vehicle_id
- model_version
- inference_latency_ms
- repeated Detection

Detection
- class_id/class_name
- confidence
- bbox
- optional track_id
- estimated_distance_m
- risk_level
```

특정 YOLO library의 tensor 내부 포맷을 protobuf contract에 노출하지 않는다.

---

# 10. 보안 모델

## 10.1 Trust Boundary

- 인증 authority: Node.
- FastAPI: Node-issued credential local validation.
- Tauri/Android: DB credential 보유 금지.
- Object Storage: scoped upload credential/presigned URL.
- Node↔FastAPI internal network: 인증 + 접근 제한.

## 10.2 Token Strategy

분리된 audience/scope 예:

- operator dashboard.
- Android device.
- vision inference.
- internal service call.
- object storage upload/download.

routing 정보는 JWT claim에 장기간 고정하지 않고 bootstrap/service descriptor로 전달한다.

## 10.3 Media Security

- object key에 secret 포함 금지.
- presigned URL은 짧은 expiry.
- upload credential은 bucket/prefix 제한.
- event image/video retention 정책 정의.
- access audit 정책 정의.

---

# 11. Observability

## 11.1 공통 Correlation Key

가능한 경우 모든 로그에 포함:

- request_id.
- vehicle_id.
- trip_id.
- session_id.
- frame_id.
- model_version.
- route_id/route_version.
- event_id/alert_id.

## 11.2 주요 Metrics

### Android

- capture FPS.
- inference-send FPS.
- preview FPS.
- encoder FPS.
- branch별 drop count.
- upload backlog.

### FastAPI

- gRPC RPS.
- preprocess/inference/postprocess latency.
- GPU utilization/VRAM.
- active streams.
- context cache age/hit.
- persistence queue depth/drop.
- DB batch latency.
- event-image upload latency.

### Node

- REST latency/error rate.
- auth failures.
- telemetry writes/sec.
- route deviation query latency.
- replay query latency.
- PostGIS slow query.
- active trips/vehicles.
- alert ack latency.

### Tauri

- frame/detection join success ratio.
- stale/unmatched buffer count.
- display latency.
- replay buffering.
- sync error diagnostics.

---

# 12. Repository / Delivery 구조

권장 논리 구조:

```text
vehicle-platform/
├── docs/
│   ├── architecture/
│   ├── erd/
│   ├── api/
│   └── adr/
├── contracts/
│   ├── proto/
│   └── openapi/
├── android-vehicle/
├── tauri-dashboard/
├── backend-control-node/
├── backend-vision-fastapi/
├── ai-vision/
│   ├── datasets/
│   ├── training/
│   ├── evaluation/
│   └── export/
└── deploy/
    ├── compose/
    ├── postgres/
    ├── object-storage/
    └── observability/
```

multi-repo를 사용하더라도 protobuf/OpenAPI contract는 별도 versioned package/repository로 관리하여 Android/Tauri/FastAPI/Node가 호환 버전을 pin할 수 있도록 한다.

---

# 13. 테스트 전략

## 13.1 Unit Test

- domain service.
- validation schema.
- route deviation decision.
- risk logic.
- Tauri frame join buffer.
- time-anchor lookup/interpolation.

## 13.2 Integration Test

- Node + PostgreSQL/PostGIS.
- FastAPI DB writer + Prisma-migrated test DB.
- Object Storage upload/download.
- gRPC compatibility.
- Node-issued JWT를 FastAPI가 검증하는 계약.

## 13.3 Contract Test

- protobuf backward compatibility.
- OpenAPI schema validation.
- Prisma schema ↔ FastAPI SQL/SQLAlchemy drift.
- class map ↔ model manifest compatibility.

## 13.4 Recorded Trip System Test

deterministic recorded fixture를 사용하여 다음을 검증한다.

- expected detections.
- persisted frame identity.
- alert/event generation.
- event images.
- replay synchronization.
- overlay accuracy.

## 13.5 Load / Failure Test

독립적으로 다음을 압박한다.

- high inference FPS.
- slow PostgreSQL.
- Object Storage latency/failure.
- slow Tauri consumer.
- long replay window.
- high GPS write frequency.

올바른 overload 동작은 **bounded degradation**이며 unbounded memory growth가 아니다.

---

# 14. 구현 로드맵

## Phase 0 — 계약 및 아키텍처 동결

작업:

- v16 ERD 확정.
- architecture SVG 확정.
- protobuf v1.
- Node OpenAPI baseline.
- service ownership ADR.
- local development topology.

완료 기준: 모든 컴포넌트가 identifier와 service boundary에 동의.

## Phase 1 — DB / Node 기반

- PostgreSQL/PostGIS.
- 15-table Prisma schema/migrations.
- seed/reference data.
- Node layered skeleton.
- auth/RBAC.
- vehicle/driver/trip CRUD.
- object-class policy.
- docs/health.

완료 기준: vehicle/trip 생성 및 안정적인 API 제공.

## Phase 2 — Android Frame Identity / Bootstrap

- CameraX capture.
- session/frame/timestamp.
- Node device bootstrap.
- mock direct stream.
- H.264 recording prototype.

완료 기준: 하나의 session에서 안정적인 frame identity와 PTS 확보.

## Phase 3 — 실제 AI 이전의 FastAPI Transport

- FastAPI lifecycle.
- gRPC server.
- JWT validation.
- deterministic mock inference.
- Tauri detection client.
- Node context cache.

완료 기준: Android frame → FastAPI → matching mock detection → Tauri.

## Phase 4 — Tauri Live View

- Android frame receiver.
- detection receiver.
- exact join buffer.
- overlay.
- latency diagnostics.

완료 기준: mock detection과 live preview가 안정적으로 동기화.

## Phase 5 — AI Model Integration

- dataset/training baseline.
- model export/manifest.
- GPU loader.
- preprocess/postprocess.
- distance/risk.
- model version output.

완료 기준: real detection이 Tauri에 표시되고 성능 기준 만족.

## Phase 6 — Vision Persistence

- bounded queue.
- `frame_inference` writer.
- `detection_event`.
- vision-origin alert.
- event image upload.
- metrics.

완료 기준: DB slowdown이 inference를 막지 않음.

## Phase 7 — GPS / Route Control

- telemetry ingestion.
- PostGIS write.
- route versioning.
- deviation query.
- alert + reroute.
- Tauri map.

완료 기준: route deviation이 공간적으로 계산되고 감사 가능한 record 생성.

## Phase 8 — Recording / Replay

- segmented H.264 upload.
- `trip_video`.
- `video_time_anchor`.
- replay window API.
- presigned Range GET.
- Tauri synchronized playback.

완료 기준: event 선택 시 정확한 영상 시점 및 overlay로 이동.

## Phase 9 — 운영 안정화

- structured logging.
- metrics/tracing.
- failure/backpressure drills.
- key/token rotation.
- backup/restore.
- performance tests.

## Phase 10 — Demo / Acceptance Package

- deterministic demo trip.
- model/evaluation report.
- API docs.
- ERD/architecture.
- operational runbook.
- known limitations.

## Phase 11 — 선택 기능

- LLM trip summary.
- advanced statistics/heatmap.
- additional spatial search.
- multi-camera.
- advanced tracking/risk prediction.
- 향후 별도 범위의 fleet dispatch optimizer.

---

# 15. 통합 Acceptance Criteria

다음 조건을 모두 만족하면 기준선 통합 데모 준비가 완료된 것으로 본다.

1. Android가 Node에서 bootstrap 정보를 받고 실제 FastAPI Vision endpoint에 연결한다.
2. live frame은 backend relay 없이 Android→Tauri로 전달된다.
3. inference frame은 Android→FastAPI, detection은 FastAPI→Tauri로 전달된다.
4. Tauri는 `(session_id, frame_id)`로 exact join한다.
5. FastAPI inference는 PostgreSQL COMMIT을 기다리지 않는다.
6. 위험 event/alert를 이후 Node API로 조회할 수 있다.
7. GPS 위치가 PostGIS에 저장되고 지도에 표시된다.
8. route deviation이 spatial computation으로 계산되고 record/alert가 생성된다.
9. Android recording이 Object Storage에 저장된다.
10. replay가 time anchor 기반으로 video/inference/GPS를 동기화한다.
11. Tauri는 PostgreSQL에 직접 접속하지 않는다.
12. Node는 Vision gRPC endpoint를 호스팅하지 않고 주소만 discovery한다.
13. Prisma Migrate가 유일한 schema migration authority다.
14. 저장된 event에서 model version 및 inference diagnostics를 추적할 수 있다.
15. DB/image upload/replay upload 실패가 unbounded queue 또는 synchronization 의미 변경을 유발하지 않는다.

---

# 16. 전체 프로젝트 Definition of Done

프로젝트는 아키텍처 다이어그램, protobuf/OpenAPI contract, Prisma schema, FastAPI writer, Node ownership, Tauri join logic, Android frame identity, replay timing이 **동일한 시스템 이야기를 설명할 때** 기술적으로 일관된 것으로 간주한다.

향후 기능을 추가할 때는 먼저 다음을 확인한다.

- 새로운 기능이 어느 plane에 속하는가?
- 기존 service ownership을 깨는가?
- 새로운 transport가 정말 필요한가?
- 새로운 table이 실제 source of truth를 추가하는가, 아니면 기존 값을 중복 저장하는가?
- synchronization key를 새로 정의하려는가?
- high-frequency path에 blocking dependency를 추가하는가?

이 원칙을 유지하면 기능이 늘어나더라도 전체 시스템의 경계를 명확하게 유지할 수 있다.
