# 외부 포트 및 서버 용도

이 문서는 서버 주소 `10.174.96.119` 기준으로 외부 방화벽과 NAT에서 허용할
포트를 정리한다.

## 외부에서 허용할 포트

| 포트 | 프로토콜 | 필요 여부 | 서버에서 사용하는 용도 |
|---:|---|---|---|
| `39001` | TCP | 필수 | Nginx HTTPS 운영자 대시보드와 Node API |
| `39002` | TCP | 필수 | Nginx HTTPS Vision 페이지, 재생 WebSocket, Android WebRTC 시그널링 |
| `39003` | TCP | 녹화 기능 사용 시 | Nginx를 통한 서명된 MinIO 녹화 파일 재생 |
| `39004` | TCP | 녹화 관리자 기능 사용 시 | Nginx를 통한 MinIO Console |
| `39006` | UDP | TURN 사용 시 필수 | Coturn TURN/STUN 리스너. Android 기본 WebRTC 주소 |
| `39006` | TCP | 선택 | Coturn TCP 연결 대체 경로 |
| `39007` | TCP | 선택 | Coturn TLS 연결(`turns:`) |
| `39008-39009` | UDP | TURN 사용 시 필수 | Coturn 미디어/데이터 릴레이 할당 포트 |

TURN 릴레이 포트(`39008-39009/udp`)는 Android와 서버 양방향으로 허용해야
한다. 현재 두 개의 포트를 사용한다. 단일 WebRTC 연결은 보통 하나의 릴레이
포트만 사용하지만, 재연결이 겹치거나 여러 연결이 생길 때 두 포트가 더
안전하다. 여러 Android 장치를 동시에 연결하면 범위를 더 넓혀야 한다.

현재 기본 TURN 주소는 다음과 같다.

```text
turn:10.174.96.119:39006?transport=udp
```

## 외부에 공개하지 않을 포트

다음 서비스는 서버 내부 또는 loopback에서만 접근해야 한다.

| 포트 | 바인딩 | 용도 |
|---:|---|---|
| `3000` | loopback | Node API |
| `8000` | loopback | Routing/Tracking |
| `39011` | `127.0.0.1` | Vision |
| `39012` | `127.0.0.1` | Go media relay |
| `9000` | `127.0.0.1` | MinIO API |
| `9001` | `127.0.0.1` | MinIO Console 내부 포트 |

PostgreSQL도 외부에 공개하지 않는다. 현재 Compose 설정이 다음처럼 되어
있다면 Docker가 호스트의 모든 인터페이스에 포트를 게시한다.

```yaml
- "5432:5432"
```

가능하면 다음처럼 loopback에만 바인딩한다.

```yaml
- "127.0.0.1:5432:5432"
```

## UFW 규칙 예시

```bash
sudo ufw allow 39001/tcp
sudo ufw allow 39002/tcp
sudo ufw allow 39003/tcp
sudo ufw allow 39004/tcp
sudo ufw allow 39006/udp
sudo ufw allow 39006/tcp
sudo ufw allow 39007/tcp
sudo ufw allow 39008:39009/udp
sudo ufw reload
```

녹화를 사용하지 않으면 `39003`과 `39004`를 열 필요가 없다. Coturn을
UDP만 사용할 경우 `39006/tcp`와 `39007/tcp`도 열 필요가 없다.

## NAT 또는 공유기 포트 포워딩

공유기나 클라우드 보안 그룹을 사용하는 경우 다음처럼 서버
`10.174.96.119`로 전달한다.

- TCP `39001` → Nginx 운영자 대시보드
- TCP `39002` → Nginx Vision/Android 시그널링
- TCP `39003` → Nginx MinIO signed playback
- TCP `39004` → Nginx MinIO Console
- UDP/TCP `39006` → Coturn 리스너
- TCP `39007` → Coturn TLS 리스너
- UDP `39008-39009` → Coturn 릴레이 포트

`3000`, `8000`, `39011`, `39012`, `5432`, `9000`, `9001`은 포워딩하지
않는다.

포트 `39006`의 UDP/TCP 리스너와 `39007` TLS 리스너는 외부 Coturn 서버의
`/etc/turnserver.conf`에도 같은 값으로 설정해야 한다.

```ini
listening-port=39006
tls-listening-port=39007
min-port=39008
max-port=39009
```
