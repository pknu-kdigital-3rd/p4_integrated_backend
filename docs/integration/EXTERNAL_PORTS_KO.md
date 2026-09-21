# 외부 포트 및 Docker 서비스 용도

Docker Compose 배포에서 애플리케이션 서비스는 `p4-internal` 네트워크로만
통신한다. `EXPOSE`는 호스트 포트를 열지 않으며, 아래 표의 포트만 Docker가
호스트에 게시한다.

## 외부에서 허용할 포트

| 포트 | 프로토콜 | 필요 여부 | 서버에서 사용하는 용도 |
|---:|---|---|---|
| `39001` | TCP | 필수 | Nginx 운영자 HTTPS와 Node API |
| `39002` | TCP | 필수 | Nginx Vision/WSS/Android 시그널링 HTTPS |
| `39003` | TCP | 녹화/재생 사용 시 | Nginx를 통한 MinIO 서명된 Range GET 재생 |
| `39004` | UDP/TCP | TURN 사용 시 | Coturn TURN/STUN 리스너 |
| `39005` | TCP | `turns:` 사용 시 선택 | Coturn TLS 리스너 |
| `39006-39007` | UDP | TURN 사용 시 | Coturn 릴레이 할당 범위 |

기본 TURN 주소는 다음과 같다.

```text
turn:10.174.96.119:39004?transport=udp
```

릴레이 범위는 두 개의 UDP 포트를 제공한다. 여러 Android 연결이나 재연결이
동시에 필요하면 범위를 더 넓혀야 한다.

## 외부에 공개하지 않을 포트

다음 포트는 Compose 내부 네트워크에서만 사용하며 `ports:`로 게시하지 않는다.

| 포트 | 서비스 | 용도 |
|---:|---|---|
| `5432` | PostgreSQL/PostGIS | Node 데이터베이스 |
| `3000` | Node | 내부 API |
| `8000` | Routing | 경로 계산과 tracking |
| `39011` | Vision | Python WebRTC/YOLO |
| `39012` | Relay | Go WebRTC relay와 telemetry |
| `9000` | MinIO | S3 API |
| `9001` | MinIO | Console 내부 포트 |

MinIO Console은 재생에 필요하지 않으므로 공개하지 않는다. 관리가 필요할 때만
SSH 터널이나 서버 내부에서 접근한다.

## UFW 예시

```bash
sudo ufw allow 39001/tcp
sudo ufw allow 39002/tcp
sudo ufw allow 39003/tcp
sudo ufw allow 39004/udp
sudo ufw allow 39004/tcp
sudo ufw allow 39005/tcp
sudo ufw allow 39006:39007/udp
sudo ufw reload
```

녹화를 사용하지 않으면 `39003/tcp`를 열지 않는다. TURN을 직접 연결할 수
있는 네트워크라면 `39004-39007`도 열지 않고 `TURN_URL=""`로 비활성화할 수
있다.

## Coturn 설정

```ini
listening-port=39004
tls-listening-port=39005
min-port=39006
max-port=39007
```

Docker Compose의 Coturn은 Linux에서 host network를 사용하므로 Coturn 설정의
포트와 외부 방화벽 포트가 일치해야 한다.
