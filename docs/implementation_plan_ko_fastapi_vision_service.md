# FastAPI Vision Service
## 상세 구현 계획 — v15 아키텍처 기준

**역할:** 차량 지능형 위험 감지 및 경로 관제 플랫폼 내부의 GPU 기반 Vision/Inference 서비스
**담당하지 않는 역할:** 일반 업무 백엔드, operator 인증 authority, 경로 관제 authority, replay/history public API
**주요 전송 방식:** 고빈도 추론 및 실시간 detection 출력을 위한 gRPC
**보조 전송 방식:** health/readiness/status/admin/diagnostics용 FastAPI HTTP
**DB 원칙:** Vision 소유 write만 수행하며 schema migration은 Node/Prisma가 소유

---

# 1. 서비스 목표

FastAPI Vision Service의 목적은 단순히 “YOLO를 실행한다”가 아니다. 이 서비스는 카메라 프레임을 낮은 지연으로 처리하면서, 프레임 identity를 보존하고, 실시간 detection을 Tauri에 전달하고, 중요한 결과를 감사 가능한 형태로 영속화해야 한다.

동시에 다음 조건을 만족해야 한다.

- GPU가 DB/네트워크의 느린 작업 때문에 불필요하게 idle하지 않는다.
- 동일 프레임의 identity가 Android → FastAPI → Tauri → DB까지 유지된다.
- live detection 전송은 DB COMMIT을 기다리지 않는다.
- Node 소유의 calibration/policy/trip context를 매 frame마다 동기 호출하지 않는다.
- persistence backlog가 무한 증가하지 않는다.
- Object Storage 장애가 live inference를 중단시키지 않는다.

하나의 배포 단위는 다음 요소를 포함한다.

```text
FastAPI HTTP control surface
        +
gRPC inference server
        +
GPU model runtime
        +
preprocess / postprocess
        +
distance / risk logic
        +
Node context cache
        +
Tauri detection output
        +
bounded persistence subsystem
        +
event-image object storage client
```

**실제 Vision gRPC Endpoint는 FastAPI Vision Service가 소유한다.** Node/Express는 bootstrap/service discovery 과정에서 그 주소만 반환한다.

---

# 2. 책임 경계

## 2.1 FastAPI Vision이 소유하는 것

- gRPC Vision inference endpoint.
- Vision boundary에서 FrameEnvelope validation.
- image decode/resize/normalize preprocessing.
- GPU model lifecycle.
- model inference.
- detection post-processing.
- 필요 시 object tracking.
- distance estimation.
- risk classification.
- Tauri로 실시간 `DetectionFrame` 전송.
- `model_version`, inference latency 생성.
- Node에서 받아오는 Vision context cache.
- bounded asynchronous persistence queue.
- `frame_inference` INSERT.
- 중요 탐지의 `detection_event` INSERT.
- event image upload 및 `event_image` metadata write.
- policy 조건에 따른 vision-origin `alert` INSERT.
- Vision 관련 health/readiness/metrics.

## 2.2 FastAPI Vision이 소유하지 않는 것

- operator user/password lifecycle.
- RBAC(Role Based Access Control, 역할 기반 접근 제어) authority.
- JWT issuance.
- Android device provisioning authority(기기를 자동으로 등록 및 설정하고 관리).
- 일반 vehicle CRUD.
- driver CRUD.
- trip lifecycle write.
- route 생성/이탈/reroute.
- GPS history.
- operator alert acknowledgement/note.
- replay/history public API.
- Prisma migration.
- Android→Tauri direct live frame relay.

이 경계를 깨지 않도록 code review와 ADR(Architecture Decision Record, 아키텍처 결정 기록)에서 명시적으로 관리한다.

---

# 3. Runtime Topology(실행 시점 구조)

권장 topology는 GPU allocation 단위로 하나의 application process/container를 두는 것이다.

```text
                         ┌───────────────────────────────┐
HTTP :8xxx ─────────────►│ FastAPI app                  │
                         │ health / ready / metrics     │
                         │ status / model info          │
                         ├───────────────────────────────┤
gRPC :5xxxx ────────────►│ grpc.aio server              │
                         │ VisionInference service      │
                         ├───────────────────────────────┤
                         │ Shared application state     │
                         │ - model runtime              │
                         │ - context cache              │
                         │ - persistence queue          │
                         │ - object storage client      │
                         └──────────────┬────────────────┘
                                        │
                                        ▼
                                      GPU
```

HTTP와 gRPC 서버는 동일하게 로드된 model runtime을 공유한다. worker마다 동일 모델을 중복 load하여 VRAM을 낭비하지 않는다. 향후 의도적인 multi-process/multi-GPU partitioning을 도입할 때만 별도 설계를 한다.

---

# 4. 권장 기술 스택

- Python 3.12 계열.
- FastAPI + Uvicorn.
- `grpcio`, `grpcio-tools`, `grpc.aio`.
- Pydantic v2.
- PyTorch
- OpenCV/Pillow — decode/preprocess에 필요한 범위만.
- NumPy.
- `httpx` — 비전 서비스에서 Node/Express의 internal context API를 호출하기 위한 비동기 HTTP client
- SQLAlchemy async — DB writer.
- GeoAlchemy2 — `detection_event` spatial write.
- S3-compatible SDK — event image.
- 실제 Prisma migration을 적용한 integration DB.

---

# 5. gRPC Contract

## 5.1 설계 목표

protobuf는 Android, Tauri, FastAPI가 공유하는 장기 계약이다.

요구사항:

- namespace/version 명시: `vision.v1`.
- canonical frame identity 포함.
- source width/height/encoding 포함.
- response에 model version 포함.
- optional field는 backward compatibility를 고려하여 추가.
- message size 제한.
- 명확한 gRPC status/error policy.
- framework 내부 tensor format 노출 금지.

## 5.2 대표 Contract

```proto
syntax = "proto3";
package vision.v1;

message FrameEnvelope {
  string session_id = 1;
  uint64 frame_id = 2;
  uint64 capture_timestamp_ns = 3;
  int64 vehicle_id = 4;
  bytes image = 5;
  uint32 width = 6;
  uint32 height = 7;
  string encoding = 8;
  optional float pitch_deg = 9;
  optional float roll_deg = 10;
}

message Detection {
  int32 class_id = 1;
  string class_name = 2;
  string display_name = 3;
  float confidence = 4;
  float x1 = 5;
  float y1 = 6;
  float x2 = 7;
  float y2 = 8;
  optional int64 track_id = 9;
  optional float estimated_distance_m = 10;
  string risk_level = 11;
}

message DetectionFrame {
  string session_id = 1;
  uint64 frame_id = 2;
  uint64 capture_timestamp_ns = 3;
  int64 vehicle_id = 4;
  string model_version = 5;
  float inference_latency_ms = 6;
  repeated Detection detections = 7;
}
```

## 5.3 Streaming 방식

초기 구현은 기능 검증이 쉬운 형태로 시작할 수 있지만, 지속적인 카메라 추론에는 bidirectional streaming이 적합하다.

장점:

- frame별 connection setup overhead 감소.
- detection response를 독립적으로 흘릴 수 있음.
- per-stream in-flight budget 적용 가능.

## 5.4 Flow Control

pending frame을 무한히 쌓지 않는다.

정책 예:

- stream/device별 `MAX_INFLIGHT`.
- capacity 초과 시 `RESOURCE_EXHAUSTED`.
- Android에서 stale frame replace/drop.
- inference sampling을 sender에서 수행.

실시간 안전 시스템에서는 오래된 프레임을 모두 처리하는 것보다 bounded latency를 유지하는 것이 더 중요하다.

---

# 6. 인증 및 권한

FastAPI는 authentication authority가 아니다. Node가 발급한 credential을 검증한다.

## 6.1 권장 구조

- Node: asymmetric key로 JWT sign.
- FastAPI: public key/JWKS로 local verify.
- gRPC metadata: `authorization: Bearer <token>`.
- interceptor에서 signature/issuer/audience/expiry/scope 검증.
- protected HTTP endpoint도 같은 verifier 사용.
- `/health/live`는 배포 정책에 따라 최소 정보만 public 가능.

## 6.2 Scope 예

```text
vision:infer
vision:observe
vision:admin
internal:vision-context
```

Android device token과 operator token을 불필요하게 동일 권한으로 취급하지 않는다.

---

# 7. Node 소유 Vision Context Cache

FastAPI가 필요하지만 authority는 Node에 있는 데이터:

| 데이터 | Vision에서 필요한 이유 | 권장 cache |
|---|---|---|
| camera calibration | ground-plane/distance 계산 | 긴 TTL + version refresh |
| object class threshold/display policy | warning/danger 결정 | policy version 기반 |
| active trip id | DB persistence FK/context | 짧은 TTL 또는 invalidation |

대표 endpoint:

```text
GET /internal/vehicles/{vehicleId}/vision-context
```

응답 개념:

```json
{
  "vehicleId": 12,
  "activeTripId": 991,
  "calibrationVersion": 4,
  "policyVersion": 7,
  "calibration": {
    "cameraHeightM": 1.72,
    "cameraPitchDeg": -3.2,
    "cameraRollDeg": 0.4,
    "cameraYawDeg": 0.0
  },
  "objectClassPolicies": []
}
```

### Cache 정책

- frame마다 Node 요청 금지.
- TTL expiry 후 background refresh.
- refresh 실패 시 일정 시간 stale cache 사용 가능.
- stale age metric 제공.
- calibration/policy가 전혀 없으면 값을 임의 생성하지 않고 명시적 degraded/error 처리.

---

# 8. Model Lifecycle

## 8.1 Startup

권장 순서:

1. config validation.
2. logging/metrics 초기화.
3. model manifest 읽기.
4. artifact 존재/체크섬 확인.
5. GPU device 확인.
6. model load.
7. warmup inference.
8. class map/policy contract validation.
9. gRPC readiness true.

model이 실제로 infer 가능한 상태가 되기 전에는 readiness가 true가 되면 안 된다.

## 8.2 Model Runtime Interface

입력/출력을 domain representation으로 통일한다.

```text
DecodedFrame
   ↓
PreprocessedBatch
   ↓
ModelRuntime.infer()
   ↓
RawModelOutput
   ↓
Domain Detections
```

`Detection` 객체는 YOLO library 내부 tensor를 직접 노출하지 않는다.

## 8.3 Model Version

각 runtime model은 다음 metadata를 제공해야 한다.

- model_version.
- artifact hash.
- input size.
- class map version.
- preprocess version.
- postprocess version.
- confidence profile.
- export/runtime engine version.

## 8.4 Model Upgrade / Rollback

권장 절차:

1. staging deploy.
2. recorded trip replay evaluation.
3. latency/VRAM 측정.
4. class-specific quality 비교.
5. model manifest 승인.
6. production promotion.
7. rollback 가능한 이전 artifact 유지.

live process에서 무계획 hot swap을 먼저 구현하지 않는다. 초기에는 restart-based model promotion이 단순하고 안전하다.

---

# 9. Inference Pipeline

## 9.1 Validation

FrameEnvelope에서 검증:

- `session_id` non-empty.
- `frame_id` valid.
- timestamp valid range.
- vehicle id valid.
- supported encoding.
- width/height sanity.
- image byte size 제한.
- auth principal이 vehicle inference 권한을 가짐.

## 9.2 Preprocessing

단계를 분리하여 latency 측정 가능하게 한다.

```text
bytes decode
  ↓
color conversion
  ↓
resize / letterbox
  ↓
normalize
  ↓
tensor conversion
  ↓
device transfer
```

원본 좌표로 bbox를 되돌릴 수 있도록 scale/padding transform을 명시적으로 보존한다.

## 9.3 Batching

초기에는 one-frame inference로 latency baseline을 확보한다.

이후 필요하면 micro-batching을 검토한다.

- `MICRO_BATCH_MAX`.
- `MICRO_BATCH_WAIT_MS`.
- 최대 대기시간을 작게 유지.

throughput 향상을 위해 live latency를 과도하게 희생하지 않는다.

## 9.4 GPU Inference

- inference mode/no-grad.
- mixed precision 여부 측정.
- CUDA synchronization을 불필요하게 호출하지 않음.
- GPU timing과 wall-clock latency 구분.
- OOM 처리 정책 명시.

## 9.5 Post-processing

- confidence filter.
- NMS/engine-native filtering.
- class map conversion.
- bbox coordinate restoration.
- optional tracking.
- distance estimation.
- risk evaluation.

postprocess 결과는 Tauri 전송과 persistence가 공유하는 canonical domain output이어야 한다.

---

# 10. 거리 추정 및 Risk Logic

distance estimation과 risk evaluation은 모델 confidence와 분리한다.

입력:

- camera calibration.
- detection bbox.
- image dimensions.
- camera height.
- base pitch/roll/yaw.
- frame 순간 pitch/roll.
- detected class.
- object policy threshold.

대표 흐름:

```text
Detection bbox
   ↓
reference image point 결정
   ↓
calibration / projection
   ↓
estimated_distance_m
   ↓
class warning threshold 적용
   ↓
risk_level
```

### Audit 요구사항

`detection_event`를 만들 때 실제 위험 계산에 사용한 값을 가능한 범위에서 저장한다.

- confidence.
- distance.
- warning threshold snapshot.
- pitch/roll at capture.
- telemetry source.
- class/display name snapshot.
- model version.

이렇게 해야 모델/정책이 변경된 이후에도 “왜 당시 DANGER로 판단했는가?”를 설명할 수 있다.

---

# 11. Tauri Detection Output

live output은 persistence를 기다리지 않는다.

```text
postprocess complete
    ├──► Tauri DetectionFrame send
    └──► persistence envelope enqueue
```

### 원칙

- DB failure와 live detection 전송 분리.
- Tauri consumer가 느려도 GPU global inference를 block하지 않음.
- subscriber별 bounded outbound queue.
- 오래된 detection은 drop 가능.
- `session_id + frame_id + capture_timestamp_ns`를 그대로 유지.

Tauri는 Android 프레임과 exact join하므로 FastAPI가 frame id를 새로 생성하거나 변환해서는 안 된다.

---

# 12. Persistence Architecture

## 12.1 단순 async DB 호출로는 부족한 이유

다음 패턴은 금지한다.

```python
result = infer(frame)
await db.insert(result)   # COMMIT까지 inference가 기다림
```

권장 구조:

```text
GPU/postprocess
   ↓
PersistenceEnvelope 생성
   ↓
queue.try_put(...)
   ↓
즉시 다음 inference 진행

background DB worker
   ↓
row count 또는 짧은 time window로 batch
   ↓
transactional INSERT/COMMIT
```

## 12.2 Bounded Queue

queue는 반드시 capacity를 가진다.

이유:

- PostgreSQL 장애 시 memory 무한 증가 방지.
- pending coroutine/task 폭증 방지.
- overload 정책을 명시적으로 적용 가능.

예시 priority:

- **P0 Critical:** DANGER event / alert.
- **P1 Important:** WARNING event / event image metadata.
- **P2 Telemetry:** 일반 `frame_inference`.

overload에서 drop/sampling은 P2부터 적용한다.

## 12.3 `frame_inference`

목적:

- 추론한 frame identity 보존.
- model version.
- inference latency.
- frame-level detection JSON/summary.
- replay/debug/performance 분석.

PK는 `(session_id, frame_id)`.

중복 수신/재시도에 대한 idempotency 정책을 명확히 한다.

## 12.4 `detection_event`

모든 raw detection을 event로 저장하지 않는다. policy가 중요하다고 판단한 selected/risk event만 생성한다.

보존 필드:

- vehicle/trip.
- frame identity.
- capture time.
- class/display name snapshot.
- confidence.
- estimated distance.
- warning threshold snapshot.
- risk severity.
- PostGIS location 가능 시 저장.
- pitch/roll/telemetry source.
- model version 관련 정보.

## 12.5 Vision-Origin Alert

`detection_event`가 alert 조건을 충족하면 관련 `alert` INSERT를 같은 persistence transaction 또는 일관된 transaction boundary에서 처리한다.

이후 ack/note/status update는 Node가 담당한다.

## 12.6 Migration Rule

FastAPI는 shared DB migration을 실행하지 않는다.

- `schema.prisma`가 source of truth.
- Prisma Migrate만 migration 수행.
- FastAPI SQL/SQLAlchemy mapping은 CI에서 migrated test DB와 drift 검증.

---

# 13. Event Image

이벤트 이미지는 secondary path다.

흐름:

1. 설정된 severity/type에 대해서만 snapshot 선택.
2. bounded JPEG/WebP encode.
3. deterministic object key 생성.
4. Object Storage upload.
5. `event_image` metadata write.
6. live detection response는 image upload 완료를 기다리지 않음.

권장 object key:

```text
vision-events/{vehicle_id}/{trip_id}/{session_id}/{frame_id}/{event_id}.jpg
```

실패 정책:

- event record 자체는 보존 가능하면 보존.
- image upload 실패 상태/metric 남김.
- bounded retry.
- unbounded task 생성 금지.

---

# 14. HTTP Control Endpoints

대표 endpoint:

```text
GET /health/live
GET /health/ready
GET /status
GET /status/model
GET /metrics
```

### `/health/live`

process 생존 여부만 확인한다. PostgreSQL 장애를 이유로 liveness를 false로 만들어 healthy GPU process가 반복 재시작되지 않게 한다.

### `/health/ready`

다음 조건을 반영:

- model load 완료.
- warmup 성공.
- inference 가능.
- 필수 configuration valid.

persistence가 unavailable한 경우 deployment policy에 따라 degraded readiness 또는 status detail로 표현한다.

---

# 15. Configuration

Pydantic typed settings 사용.

```text
SERVER
- HTTP_HOST
- HTTP_PORT
- GRPC_HOST
- GRPC_PORT

MODEL
- MODEL_PATH
- MODEL_MANIFEST
- DEVICE
- PRECISION
- INPUT_SIZE

INFERENCE
- MAX_INFLIGHT_PER_STREAM
- CONFIDENCE_PROFILE
- MICRO_BATCH_MAX
- MICRO_BATCH_WAIT_MS

NODE_CONTEXT
- NODE_INTERNAL_BASE_URL
- CACHE_TTL_CALIBRATION_SEC
- CACHE_TTL_POLICY_SEC
- CACHE_TTL_ACTIVE_TRIP_SEC

PERSISTENCE
- DATABASE_URL
- QUEUE_CAPACITY
- BATCH_MAX_ROWS
- BATCH_MAX_WAIT_MS

OBJECT_STORAGE
- ENDPOINT
- BUCKET
- PREFIX

AUTH
- JWT_ISSUER
- JWT_AUDIENCE
- JWKS_URL / PUBLIC_KEY
```

secret/password/key/token은 startup log에 출력하지 않는다.

---

# 16. Observability

## 16.1 Structured Logging

가능한 경우:

- vehicle_id.
- trip_id.
- session_id.
- frame_id.
- model_version.
- stream/connection id.
- event_id/alert_id.
- latency phase.

## 16.2 Metrics

필수 metric 예:

```text
vision_frames_received_total
vision_frames_rejected_total
vision_inference_latency_ms
vision_preprocess_latency_ms
vision_postprocess_latency_ms
vision_detection_send_latency_ms
vision_active_streams
vision_context_cache_age_seconds
vision_persistence_queue_depth
vision_persistence_dropped_total
vision_persistence_batch_rows
vision_persistence_batch_latency_ms
vision_event_image_upload_latency_ms
vision_gpu_memory_bytes
vision_gpu_utilization
```

## 16.3 Frame Trace Timeline

특정 frame을 다음과 같이 재구성할 수 있어야 한다.

```text
capture_timestamp_ns
→ gRPC receive
→ preprocess start/end
→ inference start/end
→ postprocess end
→ detection send
→ persistence enqueue
→ DB batch commit
```

---

# 17. 장애 및 Backpressure 정책

## 17.1 Node 장애

- valid cached context를 제한된 시간 동안 사용.
- cache stale metric 증가.
- 없는 calibration/policy를 임의 생성하지 않음.
- active trip이 확실하지 않은 경우 persistence policy를 안전하게 적용.

## 17.2 PostgreSQL 장애

- live inference 계속.
- queue capacity까지만 보유.
- P2 telemetry부터 sampling/drop.
- persistence degraded status 노출.
- recovery 후 bounded flush.

## 17.3 Object Storage 장애

- live detection 계속.
- DB event 생성 가능하면 유지.
- image는 failed/pending 상태 처리.
- bounded retry.

## 17.4 GPU OOM / Model Failure

- readiness false.
- 새 inference 요청에 명시적 error.
- diagnostic log/metric.
- 무한 자동 reload loop 금지.

## 17.5 Slow Tauri Consumer

- subscriber별 bounded queue.
- stale live detection drop.
- global inference block 금지.

---


# 19. 성능 측정 원칙

측정 전 고정 숫자를 성능 약속으로 선언하지 않는다. 각 phase의 budget을 측정한다.

| 단계 | 측정 항목 |
|---|---|
| Android capture/encode | capture→send latency |
| network | Android→FastAPI |
| preprocess | decode/resize/tensor |
| GPU | inference latency |
| postprocess | NMS/distance/risk |
| detection transport | FastAPI→Tauri |
| Tauri join | receive→overlay |
| 전체 | capture→overlay |

최대 throughput보다 중요한 것은 **부하 증가 시에도 latency와 memory가 bounded 상태를 유지하는 것**이다.

추가 측정:

- p50/p95/p99 inference latency.
- frames/sec per GPU.
- concurrent stream scaling.
- VRAM high-water mark.
- DB batch throughput.
- queue saturation point.

---

# 20. 구현 단계

## Stage F0 — Contract / Skeleton

- protobuf v1.
- FastAPI health.
- gRPC echo/mock.
- config.
- logging.

완료 기준: Android/Tauri test client와 contract 통신 가능.

## Stage F1 — Auth / Context

- JWT interceptor.
- Node internal context client.
- TTL cache.
- active trip mapping.

완료 기준: Node-issued credential과 context cache 정상 동작.

## Stage F2 — Mock Pipeline

- FrameEnvelope validation.
- deterministic detection.
- Tauri compatibility.
- load/backpressure test.

완료 기준: GPU 없이 전체 transport path 검증.

## Stage F3 — Real Model Runtime

- manifest.
- GPU loader.
- preprocess/postprocess.
- metrics.
- warmup/readiness.

완료 기준: 실제 model detection 안정화.

## Stage F4 — Distance / Risk

- calibration mapping.
- telemetry handling.
- distance module.
- policy threshold.
- audit fields.

완료 기준: 위험 판단이 deterministic하고 재현 가능.

## Stage F5 — Persistence

- bounded queue.
- DB worker.
- `frame_inference`.
- `detection_event`.
- alert transaction.
- Prisma drift test.

완료 기준: DB slowdown에서도 inference 유지.

## Stage F6 — Event Image Storage

- image encode.
- object upload.
- `event_image` metadata.
- retry/degraded behavior.

## Stage F7 — Hardening

- multi-stream load.
- DB failure.
- Object Storage failure.
- slow Tauri.
- GPU fault.
- operational metrics.

## Stage F8 — Model Promotion Workflow

- staging deployment.
- recorded-trip evaluation.
- model report/version.
- rollback.

---

# 21. FastAPI Definition of Done

FastAPI Vision Service는 다음을 모두 만족해야 통합 완료로 본다.

1. 실제 Vision gRPC endpoint를 하나의 명확한 서비스로 소유한다.
2. 노드에서 발행된 인증을 검증한다.
3. `session_id`, `frame_id`, `capture_timestamp_ns`를 변경하지 않는다.
4. 모델을 로드하고 준비 되었으면 실제 추론기능이 가능해야 한다.
5. 하나의 프레임이 PostgreSQL COMMIT을 기다리지 않고 Tauri 클라이언트에 사용될 detection을 생성한다.
6. 영구적(persistence) 저장기능이 비동기로 작동한다.
7. FastAPI vision write가 Prisma-migrated schema와 일치한다.
8. Node가 소유한 context는 프레임마다 호출하지 않고 cache된다.
9. 이벤트 저장이 실시간 추론을 막지 않아야 한다.
10. inference/persistence/GPU 상태가 metric으로 노출된다.
11. DB/Object Storage/Tauri 소비자가 장애가 추론기능을 무한으로 막지 않는다.

