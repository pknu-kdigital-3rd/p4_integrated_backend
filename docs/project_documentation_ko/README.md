# ITS 통합 플랫폼 문서

**기준:** `optimize_virtual` 브랜치의 `1d1a16a` 커밋에서 확인한 코드와 스키마. 이 문서는 현재 구현을 설명한다. 이후 변경된 동작은 다시 검증해야 한다.

| 순서 | 문서 | 내용 |
|---|---|---|
| 1 | [사용자 요구사항](01_user_requirements.md) | 이해관계자, 사용자 목표, 요구사항 출처 |
| 2 | [요구사항 분석](02_requirements_analysis.md) | 범위, 제약, 추적성, 구현 상태 |
| 3 | [유스케이스](03_use_cases.md) | 행위자별 정상·예외 흐름 |
| 4 | [시스템 요구사항 명세서](04_system_requirements_specification.md) | 기능·품질 요구사항과 검증 기준 |
| 5 | [시스템 아키텍처](05_system_architecture.md) | 서비스 책임, 배포 및 데이터 흐름 |
| 6 | [도메인·데이터베이스 설계](06_domain_database_design.md) | 도메인 모델, 25개 DB 모델, ERD |
| 7 | [서브시스템·컴포넌트 명세](07_subsystems_components.md) | 컴포넌트 계약, 주요 API와 장애 처리 |

## 해석 원칙

- 이 저장소에는 과거 목표 설계와 현재 구현 문서가 공존한다. 현재 동작은 라우터·서비스 코드·Prisma 스키마·마이그레이션을 우선 근거로 판단한다.
- `UR`은 코드와 화면에서 **역추적한 사용자 요구사항**, `FR`은 검증 가능한 기능 요구사항, `QR`은 품질·운영 요구사항, `UC`는 유스케이스다. 원본 사용자 인터뷰나 승인된 요구사항 원문은 저장소에서 확인되지 않았다.
- **구현**은 실행 경로가 연결된 경우, **조건부**는 구성 또는 외부 서비스가 필요한 경우, **미제공**은 스키마나 이전 계획만 존재하는 경우다. 문서화가 실제 운영 환경의 동작 검증을 대신하지 않는다.
- `Trip`과 `VirtualTrip`은 별도 도메인이다. 가상 위치는 `VirtualVehicleState`에 있으며 실제 GPS 이력인 `VehiclePosition`에 저장되지 않는다.

## 주요 근거

[루트 README](../../README.md), [Node 앱 진입점](../../node/src/app.ts), [Node 라우터](../../node/src/modules/), [Prisma 스키마](../../node/prisma/schema.prisma), [v18 실차 ERD](../v18_its_integrated_erd.md), [v19 가상 배차 ERD](../v19_virtual_dispatch_erd.md), [라우팅 서비스](../../services/routing-tracking/main.py), [Vision 서비스](../../services/vision/app/main.py), [Go 릴레이](../../services/media-relay/main.go), [Android 안내](../../android/README.md), [개발 Compose](../../docker-compose.dev.yml), [운영 Compose](../../docker-compose.prod.yml).
