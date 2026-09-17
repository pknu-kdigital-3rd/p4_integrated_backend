# 영상 PTS와 Replay 동기화 설계

## 1. 목적

본 문서는 차량 비전 및 관제 시스템에서 **PTS(Presentation Timestamp)** 를 사용하는 이유와,
`capture_timestamp_ns`, `frame_id`, `video_pts_us`, `video_time_anchor`가 각각 어떤 역할을 가지는지 설명한다.

이 시스템에서는 실시간 AI 추론 결과와 녹화된 H.264 영상을 정확하게 다시 맞춰야 한다.
따라서 단순히 `frame_id / fps`로 재생 시점을 계산하지 않고,
카메라 캡처 시간과 인코딩된 영상의 재생 시간을 명시적으로 연결한다.

핵심 원칙은 다음과 같다.

```text
Camera / Inference Timeline
capture_timestamp_ns
        │
        │ video_time_anchor
        ▼
Encoded Video Timeline
video_pts_us
```

즉,

- `capture_timestamp_ns`는 **카메라가 프레임을 실제로 캡처한 시점**
- `video_pts_us`는 **인코딩된 영상 안에서 해당 프레임이 재생되어야 하는 시점**

을 의미한다.

---

# 2. PTS란 무엇인가

PTS는 **Presentation Timestamp**의 약자다.

영상 디코더 또는 플레이어가 특정 프레임을 **언제 화면에 표시해야 하는지** 결정할 때 사용하는
미디어 타임라인상의 시간값이다.

예를 들어 다음과 같은 PTS가 있을 수 있다.

```text
Frame A → PTS 0 us
Frame B → PTS 33,333 us
Frame C → PTS 66,666 us
Frame D → PTS 100,000 us
```

30 FPS 영상이라면 이상적인 경우 대략 33.33 ms 간격으로 증가한다.

하지만 실제 카메라 캡처와 인코더에서는 프레임 드롭, 버퍼링, 스케줄링 지연,
가변적인 캡처 간격 등이 발생할 수 있으므로 항상 정확히 일정한 간격이라고 가정하면 안 된다.

---

# 3. 왜 `frame_id / fps`만으로는 부족한가

단순한 구현에서는 다음과 같이 생각하기 쉽다.

```text
video_time = frame_id / fps
```

예를 들어,

```text
frame_id = 900
fps = 30

900 / 30 = 30초
```

이 방식은 모든 프레임이 정확히 일정한 주기로 생성되고,
한 프레임도 누락되지 않으며,
카메라 캡처와 영상 인코더의 타임라인이 완전히 동일하다는 전제가 필요하다.

실제 시스템에서는 이러한 전제가 깨질 수 있다.

대표적인 원인은 다음과 같다.

- CameraX에서 프레임 전달 간격이 일정하지 않을 수 있음
- GPU 추론 대상 프레임을 일부 샘플링할 수 있음
- 카메라 또는 처리 파이프라인에서 프레임이 drop될 수 있음
- Android encoder 내부에 buffering이 존재함
- 영상 segment가 여러 파일로 나뉠 수 있음
- 인코더 시작 시간이 CameraX session 시작 시간과 다를 수 있음
- 녹화 중 순간적으로 실제 FPS가 변동될 수 있음
- 향후 B-frame 등의 구조를 사용하면 decode/presentation 순서 차이가 발생할 수 있음

따라서 다음 식은 replay의 source of truth로 사용하지 않는다.

```text
replay_time = frame_id / nominal_fps
```

`fps`와 `start_frame_id`는 범위 확인이나 진단용 metadata로는 사용할 수 있지만,
정확한 replay sync에는 사용하지 않는다.

---

# 4. 이 시스템의 세 가지 핵심 시간/식별 값

## 4.1 `session_id + frame_id`

프레임의 **논리적 identity**다.

```text
session_id + frame_id
```

를 함께 사용하여 특정 카메라 세션 안의 정확한 프레임을 식별한다.

`frame_id`만 단독으로 사용하지 않는 이유는 Android 카메라 세션이 재시작되면
프레임 번호가 다시 시작될 수 있기 때문이다.

예:

```text
session_id = "session-A"
frame_id   = 1042
```

와

```text
session_id = "session-B"
frame_id   = 1042
```

는 서로 다른 프레임이다.

실시간 Tauri 화면에서는 Android가 보낸 프레임과 FastAPI가 보낸 detection을 다음 key로 join한다.

```text
(session_id, frame_id)
```

---

## 4.2 `capture_timestamp_ns`

Android가 카메라 프레임을 캡처한 시점의 timestamp다.

```text
capture_timestamp_ns
```

는 비전 파이프라인의 **source timeline** 역할을 한다.

Android가 생성한 이 값을 downstream에서 임의로 다시 만들지 않는다.

```text
Android
   │
   │ session_id
   │ frame_id
   │ capture_timestamp_ns
   ▼
FastAPI Vision
   │
   ▼
Tauri
```

FastAPI detection 결과에도 동일한 값을 그대로 포함한다.

이 값은 다음과 같은 용도로 사용한다.

- exact frame tracing
- inference latency 분석
- detection event 재생 위치 계산
- 영상 time anchor lookup
- 여러 downstream 시스템 간 시간 기준 통일

---

## 4.3 `video_pts_us`

`video_pts_us`는 녹화된 H.264 영상 내부의 **presentation timeline**이다.

즉,

```text
video_pts_us = 17,912,000
```

이라면 해당 영상의 약

```text
17.912초
```

시점에 프레임이 표시되어야 한다는 의미다.

`capture_timestamp_ns`는 카메라 측 시간이고,
`video_pts_us`는 영상 player가 사용하는 시간이다.

따라서 두 값은 의미가 다르다.

---

# 5. 왜 두 개의 타임라인이 필요한가

전체 시스템에는 사실상 두 개의 시간축이 존재한다.

```text
┌───────────────────────────────┐
│ Camera / Vision Timeline      │
│ capture_timestamp_ns          │
└───────────────┬───────────────┘
                │
                │ video_time_anchor
                ▼
┌───────────────────────────────┐
│ Encoded Video Timeline        │
│ video_pts_us                  │
└───────────────────────────────┘
```

AI inference는 카메라 캡처 timeline을 기준으로 동작한다.

반면 replay player는 encoded video timeline을 기준으로 동작한다.

따라서 detection event를 영상 위에 정확히 표시하려면
이 두 시간축을 연결해야 한다.

그 연결 역할을 하는 것이 `video_time_anchor`다.

---

# 6. `video_time_anchor`의 역할

`video_time_anchor`는 다음 mapping을 저장한다.

```text
capture_timestamp_ns ↔ video_pts_us
```

예:

```text
session_id           = session-A
capture_timestamp_ns = 18,430,000,000
video_pts_us         = 17,912,000
```

이 mapping은 다음을 의미한다.

```text
카메라 시간 18.430초에 캡처된 프레임
        ↕
녹화 영상의 17.912초 재생 위치
```

즉, AI 이벤트가 `capture_timestamp_ns = 18,430,000,000`에서 발생했다면
Tauri replay player는 약 `17.912초` 위치로 이동할 수 있다.

---

# 7. 실제 Replay 동기화 과정

예를 들어 FastAPI가 다음 detection event를 저장했다고 가정한다.

```text
session_id            = session-A
frame_id              = 1042
capture_timestamp_ns  = 18,430,000,000
class_name            = person
distance_m            = 2.3
risk_level            = DANGER
```

Tauri에서 운영자가 해당 이벤트를 클릭하면 다음 순서로 처리한다.

```text
Detection Event
      │
      │ capture_timestamp_ns
      ▼
video_time_anchor 조회
      │
      │ video_pts_us
      ▼
H.264 replay 위치 계산
      │
      ▼
Tauri video player seek
      │
      ▼
해당 시점 detection overlay 표시
```

예를 들어 조회 결과가 다음과 같다면,

```text
capture_timestamp_ns = 18,430,000,000
video_pts_us          = 17,912,000
```

Tauri는 다음 위치로 seek한다.

```text
17.912 seconds
```

따라서 사용자는 위험 이벤트가 발생한 실제 영상 시점을 즉시 확인할 수 있다.

---

# 8. Exact anchor가 없는 경우

모든 프레임마다 `video_time_anchor`를 저장할 필요는 없다.

Anchor를 일정 간격으로 저장하고,
가장 가까운 두 anchor 사이에서 보간할 수 있다.

예:

```text
Anchor A
capture_timestamp_ns = 10,000,000,000
video_pts_us          = 9,500,000

Anchor B
capture_timestamp_ns = 11,000,000,000
video_pts_us          = 10,500,000
```

이 사이에 있는 detection timestamp는 선형 보간으로 영상 PTS를 추정할 수 있다.

다만 실제 구현에서는 다음 조건을 고려해야 한다.

- segment 경계
- encoder reset
- timestamp discontinuity
- recording restart
- 매우 큰 프레임 drop
- 세션 변경

따라서 서로 다른 session 또는 segment를 넘어선 임의 보간은 하지 않는다.

---

# 9. 실시간 동기화와 Replay 동기화의 차이

## 실시간 Live View

Live view에서는 영상 PTS가 필요하지 않다.

Android frame과 FastAPI detection을 다음 key로 직접 join한다.

```text
session_id + frame_id
```

```text
Android Frame
(session-A, 1042)
        │
        ├─────────────┐
        │             │
        ▼             ▼
Tauri Frame       FastAPI Detection
                  (session-A, 1042)
                        │
                        ▼
                  Exact Frame Join
```

따라서 실시간 화면의 핵심은 frame identity다.

---

## Replay

Replay에서는 이미 저장된 H.264 파일을 player timeline에서 재생해야 한다.

따라서 다음 mapping이 필요하다.

```text
Detection
capture_timestamp_ns
        │
        ▼
video_time_anchor
        │
        ▼
video_pts_us
        │
        ▼
H.264 playback position
```

즉,

```text
Live   → session_id + frame_id
Replay → capture_timestamp_ns ↔ video_pts_us
```

로 역할을 분리한다.

---

# 10. 왜 network arrival time을 사용하면 안 되는가

다음과 같은 timestamp를 replay sync 기준으로 사용하면 안 된다.

```text
FastAPI가 frame을 받은 시간
GPU inference가 끝난 시간
Tauri가 detection을 받은 시간
PostgreSQL에 INSERT된 시간
```

이 값들은 모두 network 및 processing latency의 영향을 받는다.

예:

```text
Capture
  │
  │ 20 ms network
  ▼
FastAPI
  │
  │ 35 ms inference
  ▼
Detection
  │
  │ 12 ms network
  ▼
Tauri
```

arrival time은 실제 촬영 시점보다 수십 ms 이상 늦을 수 있고,
부하 상황에 따라 계속 변한다.

따라서 replay synchronization의 기준은 반드시 카메라 source timestamp인

```text
capture_timestamp_ns
```

이어야 한다.

---

# 11. PTS와 DTS의 차이

영상 시스템에는 PTS 외에도 DTS(Decoding Timestamp)가 존재할 수 있다.

- **PTS**: 화면에 표시해야 하는 시점
- **DTS**: decoder가 해당 frame을 decode해야 하는 시점

Replay UI가 관심을 가지는 것은 "언제 보여야 하는가"이므로
본 시스템의 replay mapping에서는 **PTS를 사용한다.**

특히 B-frame 등 frame reordering을 사용하는 codec 구조에서는
DTS와 PTS가 다를 수 있다.

현재 구현이 단순한 H.264 encoder 설정을 사용하더라도
데이터 모델과 인터페이스에서는 presentation timeline인 PTS를 사용하는 것이 적절하다.

---

# 12. Database 관점

`video_time_anchor`는 개념적으로 다음 정보를 가진다.

```text
video_time_anchor
────────────────────────────────────
anchor_id
trip_video_id
session_id
capture_timestamp_ns
video_pts_us
created_at
```

중요한 index 예시는 다음과 같다.

```sql
CREATE INDEX idx_video_time_anchor_capture
ON video_time_anchor (
    session_id,
    capture_timestamp_ns
);
```

그리고 replay 방향 조회를 위해 다음 index도 유용하다.

```sql
CREATE INDEX idx_video_time_anchor_pts
ON video_time_anchor (
    trip_video_id,
    video_pts_us
);
```

---

# 13. 전체 시스템에서 각 값의 책임

| 값 | 의미 | Source of Truth | 주요 용도 |
|---|---|---|---|
| `session_id` | 카메라 캡처 세션 식별 | Android | frame identity 범위 구분 |
| `frame_id` | 세션 내 프레임 번호 | Android | 실시간 exact join |
| `capture_timestamp_ns` | 실제 camera capture timeline | Android | vision/replay 기준 시간 |
| `video_pts_us` | encoded video presentation timeline | Android encoder | video seek/replay |
| `video_time_anchor` | 두 timeline 사이 mapping | Android recording metadata | replay alignment |
| `fps` | nominal recording frame rate | encoder metadata | diagnostic/range 계산 |

---

# 14. 핵심 설계 원칙

본 시스템에서는 다음 규칙을 유지한다.

### 14.1 Frame identity

```text
session_id + frame_id
```

를 exact frame identity로 사용한다.

### 14.2 Vision source timeline

```text
capture_timestamp_ns
```

를 비전 시스템의 source-of-truth timestamp로 사용한다.

### 14.3 Encoded video timeline

```text
video_pts_us
```

를 영상 재생 위치의 source of truth로 사용한다.

### 14.4 Replay synchronization

```text
capture_timestamp_ns ↔ video_pts_us
```

mapping을 사용한다.

### 14.5 금지 사항

다음을 exact replay sync 기준으로 사용하지 않는다.

```text
frame_id / fps
network arrival time
FastAPI receive time
GPU completion time
database insert time
Tauri receive time
```

---

# 15. 최종 요약

PTS를 사용하는 이유는 **AI 시스템의 카메라 시간축과 실제 H.264 영상의 재생 시간축이 서로 다른 개념이기 때문**이다.

```text
session_id + frame_id
        │
        └── exact frame identity

capture_timestamp_ns
        │
        └── camera / vision timeline
                 │
                 │ video_time_anchor
                 ▼
video_pts_us
        │
        └── encoded video playback timeline
```

따라서 이 시스템의 역할 분담은 다음과 같다.

```text
Live View
    → session_id + frame_id

Vision Timing
    → capture_timestamp_ns

Replay Position
    → video_pts_us

Vision ↔ Video Mapping
    → video_time_anchor
```

이 구조를 사용하면 프레임 drop, encoder buffering, 실제 FPS 변동, recording segment 분할 등이 발생하더라도
AI detection과 녹화 영상을 안정적으로 다시 동기화할 수 있다.

## 15. Go relay 녹화 segment와 MinIO replay

Go relay는 Python decode/inference 단계에 들어가기 전, WebRTC RTP에서 이미 완성된 불변 H.264 access unit을 녹화에 재사용한다. 따라서 추가 decode나 re-encode를 수행하지 않는다. 각 MP4/fMP4 segment는 SPS/PPS와 IDR로 시작하고, RTP 90 kHz clock을 MP4 timescale로 사용한다.

`trip_video` row에는 다음 값이 저장된다.

- `recording_session_id`, `segment_index`: Android publisher 세션 안의 segment identity
- `relay_epoch`, `start_seq`, `end_seq`: relay가 전달한 access unit 범위
- `start_pts_90k`, `end_pts_90k`: 90 kHz video timeline 범위
- `storage_bucket`, `object_key`: MinIO의 영구 object identity
- `started_at`, `ended_at`, `duration_sec`: 관측된 시각과 segment 길이

Node는 trip과 vehicle 관계를 검증한 뒤 finalized metadata를 저장한다. 재생할 때는 인증된 사용자가 Node에서 짧은 만료 시간을 가진 presigned GET URL을 요청하고, 브라우저가 MinIO에서 segment를 직접 읽는다. Node는 영상 바이트를 중계하지 않는다. Presigned URL은 만료되므로 DB에 저장하지 않는다.

기존 replay mapping에서 `video_pts_us`가 필요하면 다음과 같이 변환한다.

```text
video_pts_us = start_pts_90k * 1_000_000 / 90_000
```

Segment 경계, relay epoch 변경, RTP 누락으로 인해 연속 segment를 하나의 PTS/sequence 범위로 합치지 않는다. Replay overlay는 먼저 해당 segment의 epoch 및 PTS 범위를 확인한 뒤 기존 `video_time_anchor` mapping에 연결해야 한다.
