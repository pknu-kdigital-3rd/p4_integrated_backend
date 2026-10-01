# 1. 사용자 요구사항

## 목적과 근거

이 문서는 현재 제품의 UI, API 및 서비스 동작에서 사용자의 목적을 역추적해 서술한다. 별도 사용자 인터뷰 기록이 없으므로 다음 요구사항은 사용자에게 직접 확인된 원문이 아니다. 구현 상태와 검증 방법은 [요구사항 분석](02_requirements_analysis.md), [시스템 요구사항 명세서](04_system_requirements_specification.md)에 연결한다.

## 이해관계자와 사용 환경

| 행위자 | 주요 관심사 | 현재 접점 |
|---|---|---|
| 관제자(`OPERATOR`) | 실차 위치·운행·녹화 확인, 가상 배차 및 도로 상태 운영 | `/operator/`와 인증된 Node API |
| 관리자(`ADMIN`) | 차량 등록·수정·삭제, 관제자와 동일한 운영 기능 | Node API와 운영 화면 |
| 조회자(`VIEWER`) | 차량, 경로, 녹화, 가상 시나리오 조회 | 읽기 권한이 있는 API |
| 차량 단말 사용자 | Android 카메라 영상과 GPS/IMU 전송, 배정 운행 시작·완료 | Android 앱, 단말용 API |
| 시스템 운영자 | 서비스 실행, 설정, 상태 확인 | Compose, 헬스 엔드포인트, 로그 |

## 역추적한 사용자 요구사항

| ID | 사용자 관점의 요구 | 현재 상태 | 근거 |
|---|---|---|---|
| UR-01 | 권한에 맞게 로그인하고 시스템을 사용한다. | 구현 | [인증 라우터](../../node/src/modules/auth/auth.router.ts), [권한 미들웨어](../../node/src/common/auth/require-role.ts) |
| UR-02 | 여러 실차의 현재 위치·상태·출처를 지도에서 확인한다. | 조건부 | [추적 서비스](../../node/src/modules/tracking/tracking.service.ts), [관제 화면](../../operator-web/fleet-view.js) |
| UR-03 | BIMS 실시간/기록 재생 소스를 선택하고 GPS 중단 시 위치 보정 여부를 조절한다. | 조건부 | [추적 라우터](../../node/src/modules/tracking/tracking.router.ts), [루트 README](../../README.md) |
| UR-04 | 차량을 등록·조회·수정·삭제한다. | 구현 | [차량 라우터](../../node/src/modules/vehicle/vehicle.router.ts) |
| UR-05 | 실차에 운행을 배정하고 경로 또는 GPS 재생 전용 운행을 확인한다. | 조건부 | [운행 서비스](../../node/src/modules/trip/trip.service.ts), [운행 스키마](../../node/src/modules/trip/trip.schema.ts) |
| UR-06 | Android 영상과 탐지 결과를 라이브 뷰에서 본다. | 조건부 | [릴레이](../../services/media-relay/main.go), [Vision 재생 채널](../../services/vision/app/api/playback.py) |
| UR-07 | 단말 GPS/IMU 상태를 라이브 뷰와 지도에서 확인하고 GPS 이력을 남긴다. | 조건부 | [릴레이 텔레메트리](../../services/media-relay/internal/telemetry/), [Node 수집](../../node/src/modules/telemetry/telemetry.router.ts) |
| UR-08 | 운행별 녹화 구간을 조회·재생하고 탐지 오버레이를 확인한다. | 조건부 | [녹화 라우터](../../node/src/modules/recording/recording.router.ts), [재생 UI](../../operator-web/replay-timeline.js) |
| UR-09 | 가상 시나리오와 가상 차량을 만들고 경로를 미리 본다. | 구현 | [가상 API](../../node/src/modules/virtual/virtual.router.ts) |
| UR-10 | 지정한 가상 차량의 배차 요청을 수락·거절하거나 자동 수락을 설정한다. | 구현 | [가상 서비스](../../node/src/modules/virtual/virtual.service.ts), [시뮬레이션 작업자](../../node/src/modules/virtual/virtual-simulation.worker.ts) |
| UR-11 | 가상 운행을 제어하고 차량별 경로 자동 추종을 설정한다. | 구현 | [가상 API](../../node/src/modules/virtual/virtual.router.ts) |
| UR-12 | 가상 도로 통제·혼잡을 설정하고 영향을 확인한다. | 구현 | [가상 API](../../node/src/modules/virtual/virtual.router.ts), [라우팅 API](../../services/routing-tracking/main.py) |
| UR-13 | 장애와 준비 상태를 확인하고 서비스를 운영한다. | 조건부 | [헬스 엔드포인트](../../node/src/app.ts), [운영 안내](../integration/LINUX_STARTUP_RUNBOOK.md) |

## 사용자가 기대할 수 있는 경계

- 관제 화면의 **실차 영역**과 **가상 배차 영역**은 분리되어 있다. 가상 차량은 실제 단말 영상·GPS·녹화의 대체물이 아니다.
- 단말 영상, BIMS 실시간 위치, 지도 타일, 객체 저장소는 연결 상태와 설정의 영향을 받는다. 화면에서 데이터 출처와 연결 실패를 식별할 수 있어야 한다.
- `Alert`, `RouteDeviation`, `TransportGoal`, `DetectionEvent` 등의 테이블은 존재하지만 이 저장소의 현행 관제 API에서 완성된 사용자 기능으로 연결되지 않는다. 따라서 이 문서의 현재 사용자 요구사항에 완료 기능으로 포함하지 않는다.
