# 차량 비전 및 관제 아키텍처 — 흐름 설명

SVG 다이어그램에는 의도적으로 토폴로지, 프로토콜, 짧은 책임 라벨만 표시한다. 상세한 의미와 동작 규칙은 이 문서에서 설명한다.

| # | 흐름 | 목적 / 페이로드 |
|---|---|---|
| 1 | Android → Node/Express — HTTPS Control | 디바이스 인증 및 bootstrap 요청을 수행한다. |
| 2 | Node/Express → Android — Bootstrap | 디바이스 credential과 **Vision Service Address**를 포함한 서비스 주소 정보를 반환한다. Node는 Vision gRPC endpoint를 직접 호스팅하지 않는다. |
| 3 | Android → FastAPI Vision — gRPC Inference | GPU 추론을 위해 `FrameEnvelope`를 전송한다. **실제 Vision gRPC endpoint는 FastAPI Vision Service가 소유한다.** |
| 4 | Android → Tauri — Direct gRPC Frames | 저지연 실시간 프레임 전송 경로다. Node/Express와 FastAPI를 모두 우회한다. |
| 5 | Android → Object Storage — H.264 PUT | 로컬에서 인코딩한 영상 segment를 video PTS와 함께 업로드한다. |
| 6 | FastAPI Vision → Tauri — gRPC Detections | Android가 생성한 동일한 frame identity를 포함한 추론 결과를 스트리밍한다. |
| 7 | Tauri ↔ Node/Express — HTTPS REST | 관제 사용자 인증, RBAC, 비즈니스 API, history/replay metadata, service discovery를 담당한다. Auth/bootstrap 응답에는 JWT와 Vision Service Address가 포함될 수 있다. |
| 8 | Object Storage → Tauri — Range GET | control plane에서 승인되거나 presigned된 접근 정보를 사용해 replay media를 조회한다. |

## 소유권

| 컴포넌트 | 담당 영역 |
|---|---|
| Node / Express | Auth, RBAC, JWT 발급, service discovery, business/history/replay API |
| FastAPI Vision Service + GPU | Vision gRPC endpoint, inference, tracking/post-processing, live detections |
| PostgreSQL + PostGIS | business 데이터와 inference metadata의 공유 영속 저장소 |
| Object Storage | H.264 segment, event image, replay media |
| Tauri Dashboard | live view, control UI, frame/detection join, replay UI |
| Android Device | capture identity, live frame, inference frame, local H.264 recording |

## 프레임 동기화

- Android가 `session_id`, `frame_id`, `capture_timestamp_ns`의 원본이다.
- GPU/FastAPI는 detection 결과에 동일한 identity를 그대로 포함해 반환한다.
- 실시간 join은 arrival order가 아니라 `session_id + frame_id`를 기준으로 수행한다.
- Replay는 저장된 time anchor를 사용하여 capture time과 video PTS를 정렬한다.
- FastAPI의 persistence는 asynchronous/batched 방식으로 처리하며 inference critical path 밖에 둔다.
