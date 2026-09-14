# Integration worklog

## Phase 0 — Baseline

- Source snapshots found under `E:\project4\p4_previous_projects`.
- Dependencies were not installed in the snapshots. Canonical routing source is `bus_realtime_collected_display_20260914/poc-optimal-pth-20260911`; the separate optimal-path runtime is intentionally not imported.
- Expected ports: Node 3000, routing/tracking 8000; media ports and secure-context requirements remain component-configured.
- Vision/GPU tests are explicitly deferred because this machine is not the original GPU environment.

## Phases 1–8 — Integration implementation

- Imported Node, canonical routing/tracking, vision, relay, and Android components with their own package managers and lockfiles.
- Added v17 provenance schema/migration, generic telemetry adapters, Node tracking facade, bootstrap live-view configuration, operator dashboard, deterministic BIMS registration, and CUSTOM demo seeds.
- BIMS playback is isolated from live API calls. Existing A* and media internals were not redesigned.

## Phases 9–10 — Reproducibility and documentation

- Added root startup instructions, environment examples, health endpoints retained from Node, integrated ERD, next-plan pointer, and service-unavailable UI behavior.
- Test database migration: passed (4 migrations, including v17 integration migration).
- Node TypeScript build: passed.
- Node integration tests: 15 passed across 3 files.
- Routing/tracking unit tests: 27 passed, including offline playback isolation.
- Routing/tracking Python compile check: passed.
- Go relay: not run because Go is not installed on this machine.
- Vision/YOLO and Android streaming: not run; the user explicitly excluded GPU-related tests because this is not the original environment.

## HTTPS migration

- Added Nginx TLS ingress configuration for Node, Vision, WSS playback, and Android signaling.
- Internal upstreams are loopback HTTP: Node `3000`, Vision `39011`, routing `8000`, relay `39012`.
- Public TLS ingress is split by responsibility: operator/dashboard `39001`; Vision/WSS and Android signaling `39002`.
- Added production HTTPS URL validation, proxy-aware Node/Vision settings, secure Android network policy, and a development CA generator.
- Added `scripts/run-linux-stack.sh` for one-command Linux dependency setup, RTX 3090/CUDA validation, service startup, Nginx startup, and end-to-end health gating.
- Generated development certificate verified against its CA with SAN `IP:10.174.96.95`.
- Nginx binary is not installed on this Windows host, so ingress startup and browser/device trust remain deployment prerequisites.
