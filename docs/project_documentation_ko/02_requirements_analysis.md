# 2. 요구사항 분석

## 분석 기준

요구사항의 출처는 [사용자 요구사항](01_user_requirements.md)의 역추적 목록이다. `구현`은 라우터·서비스·화면 경로가 존재함을 뜻하며, `조건부`는 실행에 단말·BIMS 키·모델/GPU·MinIO 같은 구성 요소가 필요함을 뜻한다. 실제 성능이나 운영 가용성을 검증했다는 의미는 아니다.

## 기능군과 의존성

| 기능군 | 해당 UR | 핵심 의존성·판단 |
|---|---|---|
| 접근 제어와 차량 | 01, 04 | Node, PostgreSQL; 읽기와 쓰기 권한이 다르다. |
| 실차 위치·운행 | 02, 03, 05, 07 | 라우팅/추적 서비스와 BIMS 또는 Android 데이터; `DUAL`은 경로 계산, `REPLAY_ONLY`는 Android GPS 미리보기가 필요하다. |
| 영상·녹화 | 06, 08 | Android, Go 릴레이, Vision, 객체 저장소; 실시간 WebSocket 재생과 저장된 MP4 재생은 다른 경로다. |
| 가상 배차 | 09–12 | Node의 영속 상태와 Python 도로 그래프; 실제 운행·GPS 테이블과 상태를 섞지 않는다. |
| 운영 | 13 | Compose와 Nginx, 서비스별 상태 확인; 배포 검증은 환경별로 수행한다. |

## 우선순위와 의존 순서

아래 우선순위는 사용자 승인을 받은 사업 우선순위가 아니라, 현재 구현을 설명하고 검증할 때 필요한 **의존 순서**다.

| 단계 | 요구사항 | 분석 근거 |
|---|---|---|
| 1. 기반 | UR-01, UR-04, UR-13 | 계정·차량·DB·서비스 상태가 있어야 나머지 시나리오를 재현할 수 있다. |
| 2. 실차 관제 | UR-02–03, UR-05, UR-07 | 위치 출처와 배정 운행이 라이브 화면·녹화의 문맥이 된다. |
| 3. 영상 이력 | UR-06, UR-08 | 단말·릴레이·Vision·객체 저장소가 함께 필요하다. |
| 4. 가상 배차 | UR-09–12 | 도로 그래프, 영속 시나리오, 배차 요청, 서버 시뮬레이션 순으로 검증한다. |

## 주요 분석 결과

1. **데이터 출처가 다르다.** BIMS 위치와 Android GPS는 추적 화면에서 합쳐지지만 원본 식별자와 출처(`BIMS_LIVE`, `BIMS_REPLAY`, `DEVICE_GPS`, `RECORDED_GPS`)를 유지한다. Android GPS는 릴레이의 내부 수집 경로로 저장되며, BIMS 위치의 DB 저장은 현재 조회 API 호출에 수반된다. [추적 서비스](../../node/src/modules/tracking/tracking.service.ts), [v18 ERD](../v18_its_integrated_erd.md).
2. **실차 경로와 가상 경로의 생명주기가 다르다.** 실차는 `Trip`·`Route`, 가상 배차는 `VirtualScenario`·`VirtualTrip`·`VirtualRoute`가 관리한다. 가상 현재 위치는 `VirtualVehicleState`에 저장한다. [스키마](../../node/prisma/schema.prisma).
3. **실시간 영상과 저장 영상은 다르다.** Android는 WebRTC로 Go에 게시하고 Vision이 라이브 재생·추론 결과를 제공한다. Go는 녹화 MP4 구간을 객체 저장소에 올리고 Node에 메타데이터를 등록한다. [Go 진입점](../../services/media-relay/main.go), [녹화 서비스](../../node/src/modules/recording/recording.service.ts).
4. **재생 시간축이 여러 개다.** GPS의 `recorded_at`/`source_timestamp_ns`는 원본 기록 시간, `received_at`은 서버 수신 시간이다. 녹화는 relay epoch, frame sequence, 90 kHz PTS로 식별한다. 현재 위치와 과거 동기화를 같은 타임스탬프 하나로 처리하면 잘못된 결과가 된다. [v18 ERD](../v18_its_integrated_erd.md), [녹화 스키마](../../node/src/modules/recording/recording.schema.ts).
5. **기능 범위를 구분해야 한다.** 스키마에 있는 모든 개체가 관제 UI 또는 공개 API에서 지원되는 것은 아니다. 과거 v15 문서의 Tauri, 객체 저장소 업로드 방식, 고급 경고·통계 기능을 현행 요구사항으로 취급하지 않는다. [이전 계획](../implementation_plan_ko_whole_project.md), [Node 라우팅](../../node/src/app.ts).

## 요구사항 추적표

| UR | 기능 요구사항 | 유스케이스 | 대표 검증 |
|---|---|---|---|
| 01 | FR-01 | UC-01 | 로그인 성공·실패와 권한 거부 |
| 02–03 | FR-02, FR-03 | UC-02 | BIMS/단말 스냅샷과 소스 변경 |
| 04 | FR-04 | UC-03 | 차량 CRUD 권한·유효성 |
| 05 | FR-05 | UC-04 | 두 운행 모드의 생성·상태 전이 |
| 06–08 | FR-06, FR-07, FR-08 | UC-05, UC-06 | 라이브 연결, GPS 수집, 녹화 조회·재생 |
| 09–12 | FR-09–FR-12 | UC-07–UC-09 | 배차 상태, 가상 이동, 제한 도로 처리 |
| 13 | QR-01, QR-05 | UC-10 | 헬스·배포 확인 |

## 제약과 검증되지 않은 값

- Nginx의 HTTPS 진입점과 내부 서비스의 네트워크 경계가 필요하다. 정식 구성 파일은 [개발 Compose](../../docker-compose.dev.yml)와 [운영 Compose](../../docker-compose.prod.yml)다.
- 영상 추론·모바일 송출은 GPU, 카메라, 네트워크와 모델 파일에 의존한다. 이 문서는 프레임률·지연·가용률 목표를 새로 정하지 않는다.
- 가상 배차는 실제 도로 그래프 및 제한 데이터의 품질에 영향을 받는다. 경로가 없거나 제한 구간이 충돌할 때 실패·정지 상태를 사용한다.
- 조회자 `VIEWER`의 쓰기 제한과 내부 서비스 토큰은 별도 신뢰 경계다. 단말용 API의 인증·보호 수준은 운영 배포 전 별도 검토 항목이며, 현행 라우터의 실제 동작을 [컴포넌트 명세](07_subsystems_components.md)에 기록한다.
