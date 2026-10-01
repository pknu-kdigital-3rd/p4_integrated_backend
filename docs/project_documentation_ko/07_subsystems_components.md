# 7. 서브시스템·컴포넌트 명세

## 공통 계약

관제용 공개 HTTP API의 기준 경로는 Node의 `/api/v1`이다. Node 성공 응답은 일반적으로 `{ "data": ... }`, 오류는 `{ "error": { "code": "...", "message": "..." } }` 형태다. `BigInt` ID는 JSON 문자열이다. API의 상세 필드는 각 [Zod 스키마](../../node/src/modules/)와 `/openapi.json`을 기준으로 확인한다. 내부·Go·Python API는 동일한 응답 형식을 강제하지 않는다.

## 1. Node/Express 관제·업무 백엔드

| 컴포넌트 | 현재 책임 | 주요 경로·권한 |
|---|---|---|
| 인증·Bootstrap | 로그인, JWT 발급·검사, Vision/라우팅 주소 제공 | `POST /api/v1/auth/login`, `GET /api/v1/auth/me`, `GET /api/v1/bootstrap`; [라우터](../../node/src/modules/auth/auth.router.ts) |
| 차량 | 차량 CRUD, 상태·제원·출처 관리 | `GET/POST /api/v1/vehicles`, `GET/PATCH/DELETE /api/v1/vehicles/:vehicleId`; 생성·삭제 관리자, 수정 관리자/관제자, 조회 세 역할 모두. [라우터](../../node/src/modules/vehicle/vehicle.router.ts) |
| 추적 | Python 스냅샷과 DB 차량 결합, 현재 경로, BIMS 소스 제어 | `GET /api/v1/tracking/vehicles`, `GET .../vehicles/:vehicleId`, `GET/PUT .../telemetry-mode`, `GET .../trips/:tripId/route`; PUT은 관리자/관제자. [라우터](../../node/src/modules/tracking/tracking.router.ts) |
| 실차 운행 | 운행 생성·취소·표시, Android 단말의 시작·완료·GPS 미리보기 | `GET/POST /api/v1/trips`, `GET /api/v1/trips/:tripId/display`, `POST .../:tripId/cancel`, `/api/v1/device/...`; [운행 라우터](../../node/src/modules/trip/trip.router.ts), [단말 라우터](../../node/src/modules/trip/device-trip.router.ts) |
| 녹화·재생 | 녹화 문맥 검증, MP4 구간·탐지 샘플 등록, 목록·재생 URL·삭제 | `/internal/recordings/*`는 서비스 토큰; `/api/v1/trips/:tripId/videos`, `/api/v1/trip-videos/:id` 등은 JWT. [라우터](../../node/src/modules/recording/recording.router.ts) |
| 단말 GPS | 단말/운행 문맥 확인과 GPS 배치 저장 | `POST /internal/telemetry/validate`, `POST /internal/telemetry/gps`; 서비스 토큰과 기능 설정 필요. [라우터](../../node/src/modules/telemetry/telemetry.router.ts) |
| 가상 배차 | 시나리오, 차량, 초안, 요청, 운행 명령, 도로 제한, 운영 이벤트 | `/api/v1/virtual/*`; 조회는 세 역할, 변경은 관리자/관제자. [라우터](../../node/src/modules/virtual/virtual.router.ts) |

실차 운행의 `DUAL`은 목적지 좌표가 필요하며 최근 실시간/단말 GPS가 없으면 출발점 좌표가 필요하다. `REPLAY_ONLY`는 같은 차량의 업로드된 GPS 미리보기와 단말 시작 시 지문 확인이 필요하다. Node는 추적 서비스 연결 실패를 `TRACKING_SERVICE_UNAVAILABLE` 503으로 표면화한다. [운행 스키마](../../node/src/modules/trip/trip.schema.ts), [추적 클라이언트](../../node/src/modules/tracking/tracking.client.ts).

**권한 경계:** `/api/v1/device/*`에는 일반 사용자용 JWT 미들웨어가 직접 연결되어 있지 않다. 내부 녹화·GPS API에는 `requireInternalServiceToken`이 연결되어 있다. 배포 보안 판단에서는 두 경로를 혼동하지 않는다. [Node 앱](../../node/src/app.ts), [내부 토큰 미들웨어](../../node/src/common/auth/require-internal-service-token.ts).

## 2. Operator Web

정적 HTML/CSS/JavaScript 화면을 Node가 `/operator/`에서 제공한다. 화면은 실차 지도·운행·라이브 뷰·녹화 재생과 별도 가상 배차 작업 공간을 갖는다. 실차 위치는 추적 API의 주기 조회와 라이브 텔레메트리 메시지로 갱신된다. 녹화는 MP4와 탐지 샘플을 PTS에 맞춰 표시한다. 조회 가능한 데이터가 없거나 서비스가 실패하면 연결/데이터 부재 상태를 보여준다. [화면 진입점](../../operator-web/app.js), [라이브 지도](../../operator-web/live-map.js), [가상 배차 UI](../../operator-web/virtual-dispatch.js), [UI 상태 기록](../ITS_OPERATOR_WEB_UI_REDESIGN_STATUS.md).

## 3. 라우팅·추적 FastAPI

| 내부 기능 | 계약 | 상태·실패 |
|---|---|---|
| 현재 차량 | `GET /internal/vehicles`, `GET /internal/vehicles/{external_id}` | BIMS와 단말 위치를 정규화; 데이터 없음·준비 전 상태는 구별한다. |
| 소스 상태/전환 | `GET /internal/telemetry/status`와 Node 추적 클라이언트가 호출하는 전환 API | `live`/`playback`, BIMS 기록 경로 보정 여부. Playback은 실시간 BIMS 호출 없이 기록 데이터 사용. |
| 일반 A* | `POST /api/route`, `POST /api/nearest` | OSM 그래프·차량 제약 기반 계산. 경로/근접 도로가 없으면 404. |
| 내부 경로 계산 | `POST /internal/routing/route`, `POST /internal/routing/snap`, `POST /internal/routing/match-preview` | Node 실차/가상 운행과 GPS 미리보기 도로 매칭에서 사용. |
| 가상 도로 제한 | `/internal/routing/road-restrictions/brush`, `/resolve`, 그래프 버전 조회 | 영향을 받는 방향 간선·물리 도로 구간을 계산한다. |

근거: [FastAPI 진입점](../../services/routing-tracking/main.py), [관측 계약](../../services/routing-tracking/telemetry.py), [도로 그래프](../../services/routing-tracking/graph_backend.py). Python 서비스는 사용자의 영속 운행·계정 DB를 소유하지 않는다.

## 4. Android·Go 릴레이·Vision

| 컴포넌트 | 입력 → 처리 → 출력 | 주요 계약 |
|---|---|---|
| Android | 카메라 H.264와 GPS/IMU → WebRTC/DataChannel → Go | `POST /offer/android`로 SDP 협상; 운행 조회·시작·완료와 재생 GPS 미리보기 업로드. [Android 안내](../../android/README.md) |
| Go/Pion 릴레이 | Android WebRTC → Vision 피드·텔레메트리 전달·MP4 구간 저장 | `POST /offer/android`, `GET /healthz`, `GET /internal/status`; 유효한 단말 문맥을 Node에 확인하고 녹화 시 객체 저장소에 업로드. [시그널링](../../services/media-relay/internal/signaling/handlers.go), [Go 진입점](../../services/media-relay/main.go) |
| Vision FastAPI | H.264 피드·GPS/IMU → 탐지/거리 추정·라이브 프레임 → 브라우저 | `GET /`, `WS /ws/playback`, `POST /internal/telemetry`, `GET /health/live`. WebSocket은 라이브 버퍼·재동기화 채널이다. [Vision 진입점](../../services/vision/app/main.py), [재생 채널](../../services/vision/app/api/playback.py) |

Vision 추론은 모델·CUDA 환경에 의존한다. 영상 게시가 성립해도 세션 검증 실패 또는 기능 비활성화로 녹화·단말 텔레메트리는 꺼질 수 있다. 객체 저장소 장애는 MP4 등록·재생에 영향을 준다. 영구 녹화 재생의 API는 Vision WebSocket이 아니라 Node와 객체 저장소가 제공한다.

## 5. 데이터·배포 컴포넌트

- **PostgreSQL/PostGIS:** Prisma 마이그레이션이 스키마를 소유한다. Node가 업무·GPS·가상 상태를 저장한다. `geography` 열의 읽기/쓰기는 SQL 경로가 필요하다. [스키마](../../node/prisma/schema.prisma).
- **S3 호환 객체 저장소:** Go가 MP4를 저장하고 Node가 메타데이터와 임시 재생 URL을 관리한다. [녹화 서비스](../../node/src/modules/recording/recording.service.ts).
- **Nginx·Compose:** HTTPS/WSS 공개 진입과 내부 프로세스 연결을 구성한다. 현재 저장소의 Compose 파일은 [`docker-compose.dev.yml`](../../docker-compose.dev.yml)과 [`docker-compose.prod.yml`](../../docker-compose.prod.yml)이다. [Nginx 설명](../../deploy/nginx/README.md).
- **운영 상태:** Node의 `/health/live`·`/health/ready`, Python 서비스들의 생존/준비 경로, Go `/healthz`를 조합해 확인한다. 헬스 성공만으로 Android 단말 스트리밍이나 GPU 추론 품질을 보증하지 않는다.

## API와 모델의 미연결 영역

Prisma의 `Alert`, `RouteDeviation`, `TransportGoal`, `DetectionEvent` 등은 데이터 구조를 제공하지만 이 브랜치의 공개 관제 라우터에 대응하는 완성 사용자 API가 없다. 화면의 경고·통계 영역도 실제 데이터 연결 전 상태로 기록되어 있다. 이를 현행 제품의 제공 API로 목록화하지 않는다. [Node 앱](../../node/src/app.ts), [UI 상태 기록](../ITS_OPERATOR_WEB_UI_REDESIGN_STATUS.md).
