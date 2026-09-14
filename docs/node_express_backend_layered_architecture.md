# Node.js / Express 백엔드 계층형 아키텍처 설계

## 1. 개요

본 백엔드는 Node.js, Express, TypeScript, Prisma, PostgreSQL을 기반으로 구성하며, 애플리케이션 내부 구조는 **계층형 아키텍처(Layered Architecture)** 를 따른다.

REST API 구현에서는 다음과 같은 흐름을 기본 구조로 사용한다.

```text
Router
  ↓
Controller
  ↓
Service
  ↓
Repository
  ↓
Prisma
  ↓
PostgreSQL
```

이 구조는 일반적으로 다음과 같이 부를 수 있다.

> **Router–Controller–Service–Repository 기반 계층형 아키텍처**

또는 간단히:

> **Controller–Service–Repository Pattern**

Router는 별도의 비즈니스 계층이라기보다 HTTP API 진입점을 구성하는 Presentation Layer의 일부로 본다.

---

# 2. 전체 계층 구조

전체 구조를 논리적인 계층으로 구분하면 다음과 같다.

```text
┌───────────────────────────────┐
│ Presentation / API Layer      │
│                               │
│ Router                        │
│ Controller                    │
└───────────────┬───────────────┘
                │
                ▼
┌───────────────────────────────┐
│ Business Layer                │
│                               │
│ Service                       │
└───────────────┬───────────────┘
                │
                ▼
┌───────────────────────────────┐
│ Data Access Layer             │
│                               │
│ Repository                    │
└───────────────┬───────────────┘
                │
                ▼
┌───────────────────────────────┐
│ Infrastructure Layer          │
│                               │
│ Prisma                        │
│ PostgreSQL / PostGIS          │
└───────────────────────────────┘
```

각 계층은 자신의 역할에 집중하고, 상위 계층이 하위 계층을 호출하는 방향으로 의존성을 유지한다.

---

# 3. Router

Router는 HTTP 요청의 **URL과 HTTP Method를 Controller에 연결하는 역할**을 담당한다.

예:

```ts
vehicleRouter.get(
  "/",
  vehicleController.getAll,
);

vehicleRouter.post(
  "/",
  validateBody(createVehicleSchema),
  vehicleController.create,
);
```

그리고 `app.ts`에서:

```ts
app.use(
  "/api/v1/vehicles",
  vehicleRouter,
);
```

이 두 정의가 결합되어 다음 API를 구성한다.

```text
GET  /api/v1/vehicles
POST /api/v1/vehicles
```

Router에는 가능한 한 비즈니스 로직을 작성하지 않는다.

### Router의 주요 책임

```text
HTTP Method 정의
URL Path 정의
Middleware 연결
Controller 연결
```

예:

```text
POST /api/v1/vehicles
        │
        ▼
validateBody()
        │
        ▼
vehicleController.create()
```

Router가 직접 Prisma를 호출하는 형태는 피한다.

```ts
vehicleRouter.get("/", async (req, res) => {
  const vehicles =
    await prisma.vehicle.findMany(); // 권장하지 않음
});
```

---

# 4. Controller

Controller는 **HTTP 요청과 응답을 처리하는 계층**이다.

주요 책임은 다음과 같다.

```text
Request 데이터 수신
Service 호출
HTTP Status Code 설정
Response JSON 반환
```

예:

```ts
async create(
  req: Request,
  res: Response,
) {
  const vehicle =
    await vehicleService.createVehicle(
      req.body,
    );

  res.status(201).json({
    data: vehicle,
  });
}
```

Controller는 다음과 같은 HTTP 개념을 알고 있다.

```text
req
res
HTTP Status Code
Header
Query Parameter
Path Parameter
Request Body
Response Body
```

그러나 Controller 내부에서 직접 DB Query를 작성하는 것은 피한다.

잘못된 예:

```ts
async create(req, res) {
  const vehicle =
    await prisma.vehicle.create({
      data: req.body,
    });

  res.json(vehicle);
}
```

권장 구조:

```text
Controller
    ↓
Service
    ↓
Repository
    ↓
Prisma
```

---

# 5. Service

Service는 애플리케이션의 **비즈니스 로직을 담당하는 핵심 계층**이다.

초기 구현에서는 다음과 같이 단순해 보일 수 있다.

```ts
async createVehicle(input) {
  return vehicleRepository.create(input);
}
```

그러나 시스템이 커지면 Service에서 처리할 로직이 증가한다.

예를 들어 Vehicle 등록 과정에서 다음과 같은 조건이 추가될 수 있다.

```text
차량 등록 권한 확인

Vehicle Code 중복 여부 확인

차량 상태 검증

현재 운영 상태 확인

관련 Device 존재 여부 확인

기본 Camera 설정 생성

관련 서비스 호출

Audit Log 기록
```

이러한 로직은 Controller나 Repository가 아닌 Service에서 처리하는 것이 적절하다.

예:

```ts
async createVehicle(input) {
  const existing =
    await vehicleRepository.findByCode(
      input.vehicleCode,
    );

  if (existing) {
    throw new AppError(
      409,
      "Vehicle already exists",
      "VEHICLE_ALREADY_EXISTS",
    );
  }

  return vehicleRepository.create(input);
}
```

Service는 가능하면 HTTP 개념에 의존하지 않는 것이 좋다.

즉 다음과 같은 코드는 Service에 넣지 않는다.

```ts
res.status(409)
req.body
req.params
```

Service는 다음과 같은 형태의 데이터를 다룬다.

```text
CreateVehicleInput
Vehicle
Route
Location
User
Domain Rule
Business Rule
```

---

# 6. Repository

Repository는 **데이터 저장소 접근을 담당하는 계층**이다.

현재 프로젝트에서는 Repository 내부에서 Prisma를 사용한다.

예:

```ts
export const vehicleRepository = {
  async findAll() {
    return prisma.vehicle.findMany();
  },

  async create(input) {
    return prisma.vehicle.create({
      data: input,
    });
  },
};
```

Repository가 담당하는 영역은 다음과 같다.

```text
SELECT
INSERT
UPDATE
DELETE

Prisma Query
Transaction

DB Query 조건

Persistence 관련 처리
```

Service는 가능하면 Prisma Query의 세부 구현을 알 필요가 없다.

예:

```text
Service

vehicleRepository.findById(id)
        ↓

Repository

prisma.vehicle.findUnique(...)
        ↓

PostgreSQL
```

이 구조를 사용하면 향후 Query가 복잡해져도 Service의 비즈니스 로직을 크게 변경하지 않을 수 있다.

---

# 7. Prisma의 위치

Prisma는 별도의 애플리케이션 계층이라기보다 **Infrastructure / Persistence 구현 도구**로 본다.

예:

```text
Repository
    ↓
Prisma Client
    ↓
PostgreSQL
```

PrismaClient는 애플리케이션 전체에서 하나의 공통 인스턴스를 사용하는 형태가 적절하다.

예:

```text
src/
└── infrastructure/
    └── database/
        └── prisma.ts
```

```ts
export const prisma =
  new PrismaClient({
    adapter,
  });
```

Repository에서는 다음과 같이 사용한다.

```ts
import { prisma } from
  "../../infrastructure/database/prisma.ts";
```

각 Repository에서 새로운 `PrismaClient`를 생성하지 않는다.

---

# 8. Validation 계층

Express에는 FastAPI의 Pydantic과 동일하게 자동 Request Body validation을 수행하는 기능이 기본 제공되지 않는다.

따라서 본 프로젝트에서는 Zod를 사용한다.

예:

```ts
export const createVehicleSchema =
  z.object({
    vehicleCode:
      z.string().min(1),

    vehicleName:
      z.string().optional(),

    vehicleStatus:
      z.enum([
        "READY",
        "DRIVING",
        "STOPPED",
        "MAINTENANCE",
        "OFFLINE",
      ]),
  });
```

Router에서는 Validation Middleware를 Controller 앞에 배치한다.

```ts
vehicleRouter.post(
  "/",
  validateBody(createVehicleSchema),
  vehicleController.create,
);
```

전체 흐름은 다음과 같다.

```text
HTTP Request
      ↓
express.json()
      ↓
Zod Validation
      │
      ├─ 실패
      │    ↓
      │  400 Bad Request
      │
      └─ 성공
           ↓
       Controller
           ↓
        Service
           ↓
       Repository
```

즉 잘못된 입력 데이터는 Controller에 도달하기 전에 차단한다.

---

# 9. Error Handling

Service와 Repository에서 발생한 오류는 중앙 Error Middleware에서 처리한다.

예:

```ts
throw new AppError(
  404,
  "Vehicle not found",
  "VEHICLE_NOT_FOUND",
);
```

전체 흐름:

```text
Controller
    ↓
Service
    ↓
Repository
    ↓
Error 발생
    ↓
Express Error Middleware
    ↓
HTTP Error Response
```

예:

```json
{
  "error": {
    "code": "VEHICLE_NOT_FOUND",
    "message": "Vehicle not found"
  }
}
```

이 방식을 사용하면 각 Controller에서 반복적으로 다음과 같은 코드를 작성하지 않아도 된다.

```ts
try {
  ...
} catch {
  res.status(500).json(...);
}
```

특히 Express 5에서는 `async` Controller에서 발생한 Promise rejection이 Error Middleware로 전달되므로 구조를 단순하게 유지할 수 있다.

---

# 10. 추천 디렉터리 구조

현재 프로젝트에서는 기능 단위(Module-oriented)로 구성하고, 각 Module 내부에 Layer를 배치하는 방식을 사용한다.

```text
src/
├── app.ts
├── server.ts
│
├── config/
│   ├── env.ts
│   └── logger.ts
│
├── common/
│   ├── errors/
│   │   ├── app-error.ts
│   │   └── error-handler.ts
│   │
│   └── middleware/
│       └── validate-body.ts
│
├── infrastructure/
│   └── database/
│       └── prisma.ts
│
├── generated/
│   └── prisma/
│
└── modules/
    ├── vehicle/
    │   ├── vehicle.router.ts
    │   ├── vehicle.controller.ts
    │   ├── vehicle.service.ts
    │   ├── vehicle.repository.ts
    │   └── vehicle.schema.ts
    │
    ├── route/
    │   ├── route.router.ts
    │   ├── route.controller.ts
    │   ├── route.service.ts
    │   ├── route.repository.ts
    │   └── route.schema.ts
    │
    └── location/
        ├── location.router.ts
        ├── location.controller.ts
        ├── location.service.ts
        ├── location.repository.ts
        └── location.schema.ts
```

이 구조는 계층별로 전체 프로젝트를 나누는 다음 방식보다 현재 프로젝트에 더 적합하다.

```text
controllers/
services/
repositories/
```

프로젝트 규모가 커질 경우 위 방식에서는 서로 관련된 파일들이 멀리 떨어지게 된다.

예:

```text
controllers/vehicle.controller.ts

services/vehicle.service.ts

repositories/vehicle.repository.ts
```

반면 Module 기반 구조에서는 Vehicle 관련 코드가 한 위치에 모인다.

```text
modules/
└── vehicle/
    ├── vehicle.router.ts
    ├── vehicle.controller.ts
    ├── vehicle.service.ts
    ├── vehicle.repository.ts
    └── vehicle.schema.ts
```

따라서 본 프로젝트에서는 **Feature/Module 기반 디렉터리 + 내부 Layered Architecture**를 권장한다.

---

# 11. 각 파일의 책임

## vehicle.router.ts

```text
URL
HTTP Method
Middleware
Controller 연결
```

## vehicle.controller.ts

```text
Request
Response
HTTP Status
Service 호출
```

## vehicle.service.ts

```text
Business Logic
Domain Rule
여러 Repository 조합
다른 Service와 협업
```

## vehicle.repository.ts

```text
Prisma
Database Query
Persistence
Transaction
```

## vehicle.schema.ts

```text
Zod Request Validation
Request DTO Type
Parameter Validation
```

---

# 12. 의존성 방향

기본적인 의존성 방향은 다음과 같이 유지한다.

```text
Router
  ↓
Controller
  ↓
Service
  ↓
Repository
  ↓
Infrastructure
```

반대 방향으로 의존하지 않는 것이 중요하다.

예를 들어 Repository가 Controller를 import하면 안 된다.

```text
Repository
    ↓
Controller

X
```

Service가 `Request`, `Response`를 받는 것도 가능한 한 피한다.

잘못된 예:

```ts
async createVehicle(
  req: Request,
  res: Response,
) {
}
```

권장:

```ts
async createVehicle(
  input: CreateVehicleInput,
) {
}
```

HTTP와 비즈니스 로직을 분리함으로써 Service는 REST API뿐 아니라 WebSocket, Background Worker 등에서도 재사용할 수 있다.

---

# 13. MVC와의 차이

이 구조를 MVC라고 부르는 경우도 있으나 정확하게는 전통적인 MVC와 다르다.

MVC:

```text
Model
View
Controller
```

현재 REST Backend:

```text
Router
Controller
Service
Repository
```

REST Backend에는 일반적으로 Server-side View가 없으며 JSON Response를 반환한다.

따라서 본 프로젝트 구조를 설명할 때는 다음 표현이 더 정확하다.

> Layered Architecture with Controller–Service–Repository Pattern

또는:

> Router–Controller–Service–Repository Layered Architecture

---

# 14. Clean Architecture와의 차이

현재 구조가 Clean Architecture와 일부 개념을 공유하지만 동일한 것은 아니다.

Clean Architecture에서는 일반적으로 다음 개념을 보다 엄격하게 적용한다.

```text
Domain Entity

Use Case

Port

Interface

Adapter

Dependency Inversion
```

예:

```text
Controller
    ↓
Use Case
    ↓
Repository Interface
    ↑
Prisma Repository Implementation
```

현재 프로젝트 단계에서 모든 Repository에 Interface를 만들고 완전한 Dependency Injection 구조를 도입하면 코드 복잡도가 크게 증가할 수 있다.

따라서 초기 구현에서는:

```text
Router
Controller
Service
Repository
Prisma
```

구조를 유지하고, 향후 필요한 영역에만 Interface 또는 Adapter를 도입하는 방식이 적절하다.

---

# 15. 본 프로젝트의 권장 원칙

본 Node/Express Backend에서는 다음 원칙을 따른다.

```text
1. Router는 URL과 Middleware 연결만 담당한다.

2. Controller는 HTTP 처리만 담당한다.

3. Service는 비즈니스 로직을 담당한다.

4. Repository는 DB 접근만 담당한다.

5. Prisma는 Repository 아래의 Infrastructure로 사용한다.

6. Zod는 HTTP 입력 경계에서 검증한다.

7. Error는 중앙 Error Middleware에서 처리한다.

8. PrismaClient는 공통 인스턴스를 사용한다.

9. 기능별 Module 디렉터리를 사용한다.

10. HTTP DTO와 DB Model을 항상 동일한 것으로 간주하지 않는다.
```

---

# 16. 최종 요청 처리 흐름

Vehicle 생성 API를 예로 들면 다음과 같다.

```text
POST /api/v1/vehicles
          │
          ▼
┌───────────────────────┐
│ vehicle.router.ts     │
│                       │
│ POST "/"              │
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐
│ Zod Validation        │
│                       │
│ createVehicleSchema   │
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐
│ vehicle.controller.ts │
│                       │
│ Request / Response    │
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐
│ vehicle.service.ts    │
│                       │
│ Business Logic        │
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐
│ vehicle.repository.ts │
│                       │
│ Persistence Logic     │
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐
│ Prisma Client         │
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐
│ PostgreSQL / PostGIS  │
└───────────────────────┘
```

이 구조를 이후 Vehicle, Route, Location, User/Auth, Device 등 Node.js Backend가 담당하는 각 도메인 모듈에 일관되게 적용한다.