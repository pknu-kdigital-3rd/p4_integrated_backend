# Preview Rendezvous Protocol — Design Document

**Status:** Proposed. Not yet reflected in `v16_project4_erd.md` or the architecture SVG.
**Companion to:** `v16_project4_erd.md` §"최종 아키텍처" (system architecture diagram, service boundaries)
**Scope:** How Android and Tauri find and reconnect to each other for the **direct live preview** media path, without Node or FastAPI relaying frame bytes.

---

## 0. Why this document exists

v15 fixes the *shape* of the media plane:

```text
Android ──direct gRPC live frames──► Tauri
```

and states the ownership rule that motivates it:

> Android → Tauri preview는 두 backend를 모두 우회하는 direct media path로 유지한다. 이 경로를 직접 연결하는 것이 Tauri desktop client를 채택한 핵심 이유다.

What v15 does **not** specify is *how* that direct connection gets established and kept alive: which side listens, how the two sides learn each other's address for a given `session_id`, what happens when an operator watches a different subset of vehicles mid-shift, and what happens when Tauri's address changes while Android is already streaming to it.

This document specifies that protocol. It introduces no new database tables and does not change any table in the v15 schema — the state described below (§3) is in-memory/Redis-class routing state on Node, not persisted business data. If that changes (see §8, open decisions), a schema addition would need to go through the ERD versioning process the same as v1–v15.

---

## 1. Actors and roles

Role is per-connection, not a fixed identity — the same process is a client on one connection and a server on another.

| Connection | Client (dials) | Server (listens) | Carries |
|---|---|---|---|
| Tauri ↔ Node | Tauri | Node | Auth/bootstrap, watcher registration, HTTPS REST |
| Android ↔ Node | Android | Node | Device bootstrap, session lifecycle, HTTPS |
| Android ↔ FastAPI Vision | Android | FastAPI Vision | `FrameEnvelope`, gRPC |
| FastAPI Vision ↔ Tauri | Tauri | FastAPI Vision | detections, gRPC |
| **Android ↔ Tauri (this doc)** | **Android** | **Tauri** | live preview frames, gRPC |

**Design decision — Tauri listens, Android dials, for the preview leg.** The alternative (Tauri dials Android) was rejected: mobile devices on cellular networks are typically behind carrier NAT and not reliably dialable, while the operator's desktop machine has a stable, addressable network position. This decision assumes Tauri is reachable from the device network (shared LAN, fleet VPN, or port-forward) — see §8.1.

---

## 2. Terminology

| Term | Meaning |
|---|---|
| **Watcher** | A Tauri instance registered with Node as monitoring a set of vehicles for live preview. One watcher per logged-in operator session. |
| **Watch set** | The set of `vehicle_code`s a given watcher is currently subscribed to. |
| **Active session** | A `session_id` for which Android has called `sessions/start` and not yet `sessions/end` (or timed out). Distinct from — but usually 1:1 with — the `trip_id` business concept in the v15 schema. |
| **Preview ticket** | A short-lived, Node-signed JWT scoped to exactly one `(session_id, watcher_id)` pair, presented by Android to Tauri as proof that Node authorized this specific stream. |
| **Match** | The event of Node connecting an active session to a watcher — i.e., discovering that a vehicle someone is watching now has (or already had) a live session. |
| **Focus** | Which one of a watcher's already-open preview streams Tauri is currently rendering on screen. Purely local UI state — see §5. |

---

## 3. State Node must hold

This is new state, not present in the v15 schema. It is operational/routing state, not business/audit data, and should not be persisted in PostgreSQL — recommend Redis or in-memory with the process (with the caveats in §8.2 for Node horizontal scaling).

```text
active_sessions:  vehicle_code → { session_id, trip_id, started_at }
active_watchers:  watcher_id   → { operator_user_id, vehicles: [vehicle_code],
                                    listen: { grpc_host, grpc_port, tls }, updated_at }
active_matches:   session_id   → { watcher_id, ticket_fingerprint, matched_at }
```

`active_sessions` and `active_watchers` are independent event streams that can arrive in either order. `active_matches` is the derived join between them. Every mutation to either input table must attempt to (re-)derive matches — this symmetry is the core correctness property of the protocol (§4.3).

---

## 4. Protocol flows

### 4.1 Bootstrap (existing, referenced not redefined)

Already specified in v15 §"최종 아키텍처" bullets. Included here only for completeness of the sequence:

- Android → Node: HTTPS device bootstrap → device token + Vision/Dashboard Service Address.
- Tauri → Node: HTTPS auth/bootstrap → JWT + Vision Service Address.

Neither of these has a required ordering relative to the other. They are independent credential-issuance events.

### 4.2 Watcher registration

Fired when an operator logs in, and again any time their watch set changes (§4.5, §4.6).

```http
POST /api/v1/preview/watchers HTTP/1.1
Authorization: Bearer <operator-jwt>

{
  "watcher_id": "tauri-op01-9f2c",
  "vehicles": ["TRUCK-03", "TRUCK-01"],
  "listen": { "grpc_host": "10.20.0.15", "grpc_port": 50100, "tls": true }
}
```

Node stores this in `active_watchers` and, per §4.3, checks for any vehicle in the list that already has an active session.

```json
200 OK
{
  "watcher_registered": true,
  "immediate_matches": [
    { "vehicle_code": "TRUCK-03", "session_id": "3f8a1c2e-...", "action": "ticket_issued" }
  ]
}
```

### 4.3 Session start — symmetric matching

```http
POST /api/v1/sessions/start
Authorization: Bearer <device-token>

{ "session_id": "3f8a1c2e-5b7d-4e9f-a1b2-c3d4e5f60718", "vehicle_code": "TRUCK-03", "trip_id": 3021 }
```

Node inserts into `active_sessions`, then checks `active_watchers` for any watcher covering `TRUCK-03`.

```json
200 OK
{ "session_recorded": true, "watcher_matched": false }
```
or, if a watcher already exists:
```json
200 OK
{ "session_recorded": true, "watcher_matched": true }
```

> **Rule (must hold both directions):** whichever side arrives second is the one that triggers the match. `sessions/start` checks for an existing watcher; watcher registration/add checks for an existing session. Both paths call the same internal `try_match(vehicle_code)` function. This closes the gap where a truck starting before any operator has logged in would otherwise stream into the void with no path to ever being picked up.

### 4.4 Rendezvous handshake (the match → direct connection)

Runs identically regardless of which side triggered the match in §4.3.

1. **Node → Android** (over Android's existing device control channel — the same channel used for bootstrap-time pushes):
```json
{
  "type": "open_preview",
  "session_id": "3f8a1c2e-...",
  "preview_target": { "grpc_host": "10.20.0.15", "grpc_port": 50100, "tls": true },
  "preview_ticket": "eyJhbGciOiJSUzI1Ni...<claims: session_id, watcher_id, exp=90s>...<sig>"
}
```
2. **Node → Tauri** (control channel): `{ "type": "expect_preview", "session_id": "...", "vehicle_code": "TRUCK-03", "ticket_fingerprint": "sha256:..." }`
3. **Android → Tauri**, direct dial, no Node involved from this point:
```text
gRPC → 10.20.0.15:50100  PreviewService/OpenPreview
metadata: authorization: Bearer <preview_ticket>
first message: { session_id, vehicle_code }
```
4. **Tauri validates locally** — ticket signature against Node's public key (no round-trip to Node, consistent with the v15 rule that FastAPI Vision verifies Node-issued credentials the same way), expiry, and that `session_id` matches what step 2 told it to expect.
5. **Frames stream**, Android → Tauri, carrying the same `session_id`/`frame_id`/`capture_timestamp_ns` triple used on every other leg of the pipeline (v15 §"Android가 frame identity의 원본이다").
6. **Periodic heartbeat**, both sides → Node, so staleness can be detected (§4.9).

### 4.5 Focus switch — no network activity

**Not a rendezvous event.** If a vehicle is already in the watch set, its stream is already open and frames are already arriving. Switching which vehicle is displayed is a local render-target change in Tauri:

```javascript
setActiveVehicle("TRUCK-01");   // repoints the render loop at an already-live buffer
```

No message crosses any connection. This is the case to keep separate from §4.6 — conflating the two leads to either unnecessary network churn (treating every UI click as a resubscribe) or missed teardown (never releasing a stream the operator stopped watching).

**Bandwidth variants** (decision point, not yet chosen — see §8.3): all watched streams may run full-rate, or non-focused streams may run at a reduced "thumbnail" rate with a burst-to-full message on focus change. Either variant keeps focus switching off the rendezvous path entirely — a rate change on an already-open stream is not a new handshake.

### 4.6 Watch set change — add

```http
PATCH /api/v1/preview/watchers/tauri-op01-9f2c
{ "add": ["TRUCK-09"] }
```

Triggers the same `try_match` check as §4.3, from the opposite direction. Two outcomes:

- **Session already active:** full rendezvous (§4.4) fires immediately.
- **No active session yet:** Node records the watch intent only. Nothing to dial. The vehicle shows as "waiting for stream" in Tauri until that vehicle's *next* `sessions/start`, which will find the watcher already registered and match immediately per §4.3.

### 4.7 Watch set change — remove

Ordering matters, to avoid a window where Node has forgotten the watch but frames are still arriving:

1. **Tauri cancels the gRPC stream first:** `CANCEL → PreviewService/OpenPreview (session ..., TRUCK-03)`. This is what actually stops frames.
2. **Then Tauri notifies Node:** `PATCH /api/v1/preview/watchers/tauri-op01-9f2c { "remove": ["TRUCK-03"] }`.

Android observes the cancelled RPC as its own stop signal — it does not need a separate message from Node telling it to stop.

### 4.8 Reassignment / handoff (watcher-to-watcher)

*Out of scope for this revision.* Raised during design discussion as a third case (operator B takes over a vehicle operator A was watching) but not walked through in detail. It composes from primitives already defined here — a §4.7 remove on A's watcher followed by a §4.6 add on B's watcher — but whether that should be atomic (single Node-side "reassign" call to avoid a visible gap) or left as two client-driven calls is an open decision. See §8.4.

### 4.9 Address change — push with pull fallback

Tauri's listen address can change mid-session: app restart on a new port, DHCP lease change, operator moving machines, or failover to a backup instance.

**Push (fast path).** Re-registration (§4.2, same endpoint, new `listen` block) diffs against the stored address. If it changed and a session is currently matched to that watcher, Node pushes a redirect over Android's device control channel:

```json
{
  "type": "redirect_preview",
  "session_id": "3f8a1c2e-...",
  "preview_target": { "grpc_host": "10.20.0.15", "grpc_port": 50142, "tls": true },
  "preview_ticket": "eyJ...<fresh, exp=90s>...",
  "reason": "watcher_address_changed"
}
```
Android closes the old stream and re-runs §4.4 steps 3–5 against the new address.

**Pull (safety net).** The push assumes Node reliably detects the change and can reach Android at that instant — neither is guaranteed (Tauri could crash without re-registering; the control channel could have a gap). So Android's reconnect logic must never blindly redial a cached address after any stream failure. Instead, after a short backoff:

```http
GET /api/v1/sessions/{session_id}/preview-target
Authorization: Bearer <device-token>

→ { "preview_target": {...current...}, "preview_ticket": "eyJ...<fresh>..." }
```

then dial whatever address that returns. This single habit — re-resolve before every reconnect, never trust the last known address — is what makes the system self-healing even when the push is lost.

> **Rule:** implement both. Push alone is fast but fragile (depends on Node reliably knowing and reaching Android at the right instant). Pull alone is robust but slow (no reconnection until Android happens to retry). Together, the common case has no visible interruption and the system still converges when the push fails.

### 4.10 Session end

```http
POST /api/v1/sessions/end
{ "session_id": "3f8a1c2e-..." }
```

Node clears `active_sessions[vehicle_code]` and `active_matches[session_id]`. Any watcher still holding an open stream for this session should have it closed by Android (clean shutdown) or time out via the heartbeat (§4.4 step 6) if the end call itself never arrives (device crash, connectivity loss). Tauri's ticket validation in step 4 of §4.4 is the last line of defense against a stale session being redirected to — a validated ticket's `session_id` must exist in `active_sessions` at redirect time, not just at issuance time.

---

## 5. Security properties

- **Scoping.** A preview ticket is valid for exactly one `(session_id, watcher_id)` pair and expires in ~90s. It is not a general-purpose credential — a leaked ticket only grants access to one already-known session for the window before it expires.
- **Local verification.** Tauri validates tickets against Node's public key without a round-trip to Node, matching the v15 principle that downstream services verify Node-issued credentials locally (the same pattern FastAPI Vision uses for operator/device tokens).
- **Binding.** The ticket binds *session*, *vehicle*, and *watcher* together. Without it, anything reachable on Tauri's listen port could push frames claiming to be any vehicle, or a device could be matched to the wrong operator.
- **No frame relay through Node.** Node only ever sees addresses and tickets, never frame bytes — preserving the v15 rule that the media path bypasses both backends.

---

## 6. Failure modes

| Failure | Detected by | Recovery |
|---|---|---|
| Session starts before any watcher | `active_watchers` lookup empty at §4.3 | Deferred; matched on next watcher add (§4.6) |
| Watcher added before any session | `active_sessions` lookup empty at §4.6 | Deferred; matched on next `sessions/start` (§4.3) |
| Tauri address changes mid-stream | Diff on re-registration (§4.9) | Push redirect; pull fallback if push lost |
| Tauri crashes without re-registering | Missed heartbeat (§4.4 step 6) | Android stream fails → pull re-resolution (§4.9) |
| Ticket expires before dial completes | Tauri validation (§4.4 step 4) rejects | Android re-requests via pull path (§4.9) |
| Stale session redirected to | Ticket's `session_id` absent from `active_sessions` | Tauri rejects at validation; Android re-resolves |
| Android and Node disagree on session state | Heartbeat gap | Node-side timeout expires `active_sessions` entry |

---

## 7. Message schema summary

| Message | Direction | Transport | Purpose |
|---|---|---|---|
| `POST /preview/watchers` | Tauri → Node | HTTPS | Register watch set + listen address |
| `PATCH /preview/watchers/{id}` | Tauri → Node | HTTPS | Add/remove vehicles, update listen address |
| `POST /sessions/start` | Android → Node | HTTPS | Announce a new capture session |
| `POST /sessions/end` | Android → Node | HTTPS | Announce session teardown |
| `GET /sessions/{id}/preview-target` | Android → Node | HTTPS | Pull-resolve current target + fresh ticket |
| `open_preview` push | Node → Android | device control channel | Deliver target + ticket on match |
| `redirect_preview` push | Node → Android | device control channel | Deliver new target + ticket on address change |
| `expect_preview` push | Node → Tauri | control channel | Pre-authorize an inbound dial |
| `PreviewService/OpenPreview` | Android → Tauri | gRPC (direct) | Open the frame stream |
| frame stream | Android → Tauri | gRPC (direct) | `session_id`, `frame_id`, `capture_timestamp_ns`, `frame_jpeg` |

---

## 8. Open decisions (not resolved by this document)

1. **Network topology.** The entire protocol assumes Tauri is reachable from the device network. This holds for a shared depot LAN or a fleet VPN; it does **not** hold for devices on open cellular with no overlay network. If that's the real deployment target, this document's core assumption (§1) needs revisiting — either a VPN overlay in front of this protocol, or a relay/TURN-style fallback, which reintroduces a middlebox the v15 architecture deliberately avoids.
2. **Node horizontal scaling.** §3's state is described as single-process/Redis-class. If Node runs multiple instances behind a load balancer, `active_sessions`/`active_watchers`/`active_matches` must be shared (e.g., Redis) rather than in-process, or session-start and watcher-registration calls must be sticky to the same instance.
3. **Bandwidth strategy for non-focused streams.** §4.5 leaves open whether all watched vehicles stream full-rate or step down to a thumbnail rate when not focused. Recommend deciding based on typical watch-set size per operator (see comparison in design discussion — under ~6 vehicles, full-rate is simplest and cheapest to reason about).
4. **Reassignment atomicity.** §4.8 — whether handoff between operators should be a single Node-side call or remain composed from add/remove.

---

## 9. Change log

| Date | Change |
|---|---|
| 2026-08-31 | Initial draft, derived from design discussion. Not yet merged into `v16_project4_erd.md`. |
