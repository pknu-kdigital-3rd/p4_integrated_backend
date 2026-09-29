# ITS Operator Web UI Redesign Implementation Plan

## 1. Goal

Redesign the existing ITS **operator web dashboard only** so that the presentation is very close to the supplied reference images.

Scope:

- `operator-dashboard.png`
- desktop/laptop virtual routing & dispatch UI from `virtual-dispatch-android.png`

Out of scope:

- Android UI redesign
- Android layout changes
- Android streaming UX changes
- Android settings changes

The existing Android app and its streaming/QR/telemetry behavior should remain unchanged.

The redesign is primarily a **web UI restructuring and visual refinement task**. Existing tracking, routing, virtual dispatch, recording, WebRTC, telemetry, and API behavior must continue to work.

### Primary visual direction

- Bright/light control-center theme instead of the current dark dashboard.
- Large map as the main visual surface.
- White cards with subtle borders/shadows.
- Strong blue primary action/navigation color.
- Compact rounded controls and status chips.
- Clear green/orange/red operational states.
- Normal monitoring and virtual dispatch remain distinct workspaces.
- Live video remains visible together with map context.

---

## 2. Current Project Baseline

The current operator frontend is a small vanilla HTML/CSS/JavaScript application in:

- `operator-web/index.html`
- `operator-web/styles.css`
- `operator-web/app.js`
- `operator-web/live-map.js`
- `operator-web/live-telemetry.js`
- `operator-web/replay-timeline.js`
- `operator-web/virtual-dispatch.js`
- `operator-web/workspace-sections.js`

It already supports:

- Leaflet map.
- Vehicle markers.
- Selected vehicle details.
- Planned route rendering.
- Trip creation/assignment.
- BIMS/replay telemetry source selection.
- Live View.
- Recorded trip playback with synchronized detection overlay.
- Normal/virtual workspace switch.
- Virtual scenario and vehicle creation/removal.
- Origin/destination/waypoint placement.
- Route preview and dispatch request.
- Per-vehicle follow mode.
- Pause/resume/cancel and virtual speed.
- Blocked/heavy-penalty road regions.
- Virtual vehicle movement and route updates.

### Important implementation principle

**Do not rewrite the frontend in React/Vue/etc. for this redesign.**

The current web UI is already wired directly to working application state. Preserve the existing vanilla JS architecture and refactor the DOM/CSS around the existing behavior.

---

## 3. Non-goals

This redesign should not:

- Change Android code or layouts.
- Change Node API contracts unless a UI requirement exposes a genuinely missing field.
- Change Prisma schema or migrations just for presentation.
- Change the routing algorithm.
- Change virtual vehicle simulation behavior.
- Change WebRTC transport.
- Change YOLO/vision processing.
- Change telemetry synchronization.
- Replace Leaflet.
- Add fake weather, fake vehicle counts, fake alerts, or other data solely because they appear in the mockup.
- Introduce dead navigation buttons that appear functional but have no implementation.

Where the reference image displays information not currently available, either:

1. derive it from existing data, or
2. omit/disable that element until a real source exists.

---

# 4. Design System

Implement the shared design tokens first so both normal and virtual workspaces look like the same product.

## 4.1 Color tokens

Create CSS custom properties approximately in this family:

```css
:root {
  --ui-bg: #f3f7fb;
  --ui-surface: #ffffff;
  --ui-surface-soft: #f7faff;
  --ui-border: #dce7f1;

  --ui-text: #10264a;
  --ui-text-secondary: #65758b;
  --ui-text-muted: #8b9bb0;

  --ui-primary: #0868dd;
  --ui-primary-hover: #075cc4;
  --ui-primary-soft: #eaf3ff;

  --ui-success: #13ad72;
  --ui-success-soft: #ddf8ec;

  --ui-warning: #f59a23;
  --ui-warning-soft: #fff0dd;

  --ui-danger: #ed3d4f;
  --ui-danger-soft: #ffe7ea;

  --ui-info: #16a5c8;

  --ui-shadow-card: 0 8px 24px rgba(25, 56, 95, 0.08);
  --ui-shadow-floating: 0 14px 40px rgba(18, 49, 84, 0.20);

  --ui-radius-sm: 8px;
  --ui-radius-md: 12px;
  --ui-radius-lg: 18px;
}
```

Exact values can be tuned after screenshot comparison.

## 4.2 Typography

Use a Korean-capable system font stack:

```css
font-family:
  Pretendard,
  "Noto Sans KR",
  "Apple SD Gothic Neo",
  "Malgun Gothic",
  system-ui,
  sans-serif;
```

Do not make Pretendard a hard network dependency unless it is intentionally bundled.

Recommended hierarchy:

- Product title: 20–22 px / 700.
- Workspace tabs: 14–15 px / 700.
- Card heading: 17–19 px / 700.
- Primary value: 18–24 px / 700.
- Body: 13–15 px.
- Metadata: 11–13 px.
- Status pill: 11–12 px / 700.

## 4.3 Reusable visual primitives

Implement CSS classes for:

- `.ui-card`
- `.ui-card-header`
- `.ui-section-title`
- `.ui-chip`
- `.ui-chip--success`
- `.ui-chip--warning`
- `.ui-chip--danger`
- `.ui-chip--neutral`
- `.ui-button`
- `.ui-button--primary`
- `.ui-button--secondary`
- `.ui-button--danger`
- `.ui-icon-button`
- `.ui-segmented`
- `.ui-field`
- `.ui-empty-state`
- `.ui-divider`

This is preferable to adding one-off styles for every section.

## 4.4 Icons

Use one consistent icon source.

Preferred implementation:

- local inline SVG symbols or a small checked-in SVG icon set;
- avoid introducing an icon CDN dependency.

Required icons include:

- map
- vehicle/bus
- notification
- statistics
- settings
- search
- video
- play/pause
- route
- location pin
- calendar/time
- fullscreen
- warning/closure

---

# 5. Operator Web — Overall Layout

## 5.1 Replace current dark split layout

Current layout:

```text
header
map | resizable splitter | sidebar
```

Target normal monitoring layout:

```text
┌────────────────────────────────────────────────────────────┐
│ top product header + workspace tabs + connection/status    │
├──────┬───────────────────────────────────┬─────────────────┤
│ icon │                                   │ selected vehicle│
│ rail │              MAP                  │ trip / recording│
│      │                                   │ cards           │
│      │         floating Live View        │                 │
└──────┴───────────────────────────────────┴─────────────────┘
```

Desktop proportions:

- top header: about 64–72 px.
- left navigation rail: about 72–82 px.
- right detail panel: about 390–440 px.
- map uses all remaining width.

The desktop mockup should be the main optimization target.

## 5.2 Remove the normal desktop resize splitter

The mockup uses a stable dashboard composition rather than a user-resized map/sidebar.

Recommended:

- Remove `#layout-splitter` from the normal desktop layout.
- Remove normal-mode split-ratio persistence.
- Keep responsive stacking at tablet/mobile widths.
- If retaining resize behavior is considered valuable, restrict it to Live View sizing rather than map-vs-sidebar.

This will also simplify `app.js`.

## 5.3 Header

Redesign `<header>` as a light application bar.

Left:

- product title, e.g. `부산시 ITS 통합 관제시스템`
- small subtitle, e.g. `스마트한 교통 운영`

Center:

- `일반 모니터링`
- `가상 경로·배차`

Use the existing mode buttons/IDs so `virtual-dispatch.js` behavior remains intact:

- `#normal-workspace`
- `#virtual-workspace-tab`

Right:

- actual connection state.
- local date/time generated in the browser.
- account/avatar placeholder.
- optionally a notification icon.

Do not add a weather value unless a real source is deliberately implemented.

---

# 6. Normal Monitoring Workspace

## 6.1 Left icon rail

Add a narrow rail similar to the first mockup.

Initial entries should map to actual application functions:

1. 지도 — active/default.
2. 차량 목록 — opens fleet list/filter drawer.
3. 알림 — only enable if backed by current alert data.
4. 통계 — only enable if backed by current data.
5. 설정 — can contain telemetry-source controls and display preferences.

If only Map and Settings are implemented in this iteration, show the others as disabled rather than fake interactive items.

## 6.2 Map command surface

Place lightweight controls over the top-left of the map.

### Search

Add a search field similar to the mockup:

`장소, 정류장, 차량번호를 검색하세요...`

First iteration should support data already available:

- vehicle code/name/external ID search.
- selecting the result centers the Leaflet map and selects the vehicle.

Geocoding/place search is optional and should not be faked.

### Vehicle status filter chips

Render chips from actual fleet state, for example:

- 전체
- 운행중
- 대기
- 점검
- 오프라인

If backend state naming differs, define a deterministic mapping in the frontend.

Each chip should display actual count.

Filtering changes marker visibility only; it does not mutate backend state.

## 6.3 Vehicle markers

Replace generic circle markers with presentation-ready vehicle markers.

Recommended visual model:

- blue = active/running.
- green = ready/available if such state exists.
- gray = offline.
- red = warning/inspection when represented by real state.

Selected marker:

- larger icon.
- blue halo.
- vehicle code label above it.

Android GPS/live marker must remain visually distinguishable, but use the same visual language.

Do not break marker click handling in `app.js`.

## 6.4 Planned route

Keep current route rendering logic.

Visual changes:

- primary route: strong blue line.
- route casing/shadow: subtle white or darker outline for visibility.
- start/end or current/destination markers use map pins.
- selected/current vehicle sits above route layer.

## 6.5 Map legend

Add a compact bottom-left floating legend card.

Only include states actually represented in data.

The legend must not obscure important map attribution/scale controls.

---

# 7. Right Sidebar — Normal Monitoring

Turn the current long form sidebar into vertically stacked cards.

## 7.1 Selected vehicle card

Use `#details` as the selected vehicle card.

Structure:

```text
선택 차량        [운행중]
최근 업데이트 14:28:16

[bus icon] 부산70가 1234
일반시내버스 · 70번

현재 속도 | 운행 상태 | 운행 ID
42 km/h  | 정상 운행 | ...

route progress / start-current-destination
```

Keep existing data binding but stop rendering the whole content as an undifferentiated `<dl>` if that prevents the target layout.

Recommended:

- add dedicated DOM fields for key values;
- use a small fallback metadata list for values that do not fit the primary design.

### Route progress

If route/stops data needed for exact stop progress is not currently available, show a simpler valid form:

- origin
- current position/route state
- destination

Do not synthesize stop counts.

## 7.2 Trip creation / assignment card

Restyle `#trip-panel` to match the `운행 생성·배정` card.

Progressive disclosure is important.

Default visible fields:

- vehicle.
- destination.
- planned date.
- planned time.
- primary create/assign button.

Advanced controls can expand below:

- explicit origin coordinates.
- destination coordinates.
- destination address.
- initial state.

Keep map-pick support.

When "pick on map" is active:

- visually highlight the related field/button.
- show a small map banner with instructions.

## 7.3 Telemetry-source controls

The current `Bus telemetry source` block is more of an operator/developer setting than a primary monitoring task.

Move it to:

- Settings rail item, or
- a compact expandable `데이터 소스` settings card.

Do not keep it between the selected vehicle and trip assignment cards.

## 7.4 Recording / replay card

Restyle `#recordings-panel`.

Target layout:

- heading `운행 녹화`
- segmented tabs:
  - `실시간 영상`
  - `저장된 녹화`
- preview thumbnail/mini player
- vehicle/trip/date metadata
- timeline
- compact playback controls
- speed selector

Existing replay behavior must remain:

- timeline seeking.
- source-aligned detection overlay.
- segment gap indicators.
- fullscreen.
- delete-range mode.

Destructive segment deletion should be placed behind a small overflow/management action instead of being visually prominent.

---

# 8. Live View Redesign

The current implementation changes the entire page to a map/live split and hides the sidebar.

That is not consistent with the first reference mockup.

## 8.1 Target behavior

Live View becomes a floating video card over the lower part of the map:

```text
┌────────────────────────────┐
│ 실시간 전방 영상     LIVE  │
├────────────────────────────┤
│                            │
│       video / iframe       │
│                            │
├────────────────────────────┤
│ YOLO objects / telemetry   │
└────────────────────────────┘
```

Desktop:

- width around 480–620 px depending viewport.
- bottom-right or bottom-center of map area.
- rounded corners.
- strong floating shadow.
- does not hide the right sidebar.
- does not replace the map.

Controls:

- fullscreen.
- close.
- recenter vehicle, when current live-follow logic requires it.

## 8.2 Preserve current live telemetry behavior

Do not modify the WebRTC/vision iframe contract.

Preserve:

- target retargeting.
- telemetry source-time synchronization.
- map follower.
- recenter behavior.
- foreground-resume handling.
- fullscreen postMessage behavior.

Only the panel composition should change.

## 8.3 Small screens

On tablets/mobile browser:

- Live View may become a bottom sheet/full-width panel.
- fullscreen behavior remains available.
- map must remain usable when not fullscreen.

---

# 9. Virtual Routing & Dispatch Workspace

The second mockup uses a different composition from normal monitoring.

Target:

```text
┌──────────────────────────────────────────────────────────────┐
│ shared header / workspace tabs                               │
├───────────────────┬──────────────────────────────────────────┤
│ scenario controls │                                          │
│ vehicle controls  │                  MAP                     │
│ route controls    │                                          │
│ road state        │       route / vehicle / road regions     │
│                   │                                          │
└───────────────────┴──────────────────────────────────────────┘
```

The virtual workspace should **not** simply reuse the normal right-hand sidebar.

## 9.1 Move virtual controls to a dedicated left panel

Use `#virtual-workspace`, but style/restructure it as a 260–320 px left-side control surface.

Suggested sections:

### Step 1 — 시나리오 설정

- current scenario select.
- `새로 만들기`.
- compact remove action.

Keep IDs:

- `#virtual-scenario`
- `#virtual-new-scenario`
- `#virtual-remove-scenario`

### Step 2 — 가상 차량 설정

- selected virtual vehicle.
- add/remove vehicle.
- selected vehicle status.
- follow mode.

Keep:

- `#virtual-vehicle`
- `#virtual-new-vehicle`
- `#virtual-remove-vehicle`
- `#virtual-following`

### Step 3 — 경로 및 제어

Default visible controls:

- origin.
- destination.
- waypoint count.
- route preview.
- dispatch request.
- pause/resume.
- speed selector.

Keep existing IDs/event hooks.

The current functional flow must remain:

1. select vehicle.
2. place origin/destination.
3. preview.
4. generate request.
5. accept/reject.
6. simulated movement starts according to existing backend rules.

### Step 4 — 도로 상태 설정

Present as two clear mode buttons/cards:

- `도로 차단`
- `혼잡 구간`

Then:

- pick region.
- activate region.
- penalty factor shown only for `HEAVY_PENALTY`.

The UI should visually explain the two meanings:

- blocked = impassable/red.
- congestion = passable but high routing cost/orange.

## 9.2 Route points

Keep current snap-to-road logic and draggable markers.

Improve marker appearance:

- origin = green flag.
- destination = red flag.
- waypoint = amber numbered pin/flag.

Keep tooltips short and presentation-friendly.

## 9.3 Route styling

Use:

- active/default route: blue.
- congestion-affected segment/area: orange.
- blocked region: red.
- optional candidate/draft route: lighter or dashed blue.
- current active route should be visually stronger than a draft.

## 9.4 Road region styling

Match the mockup more closely.

### BLOCKED

- red outline.
- translucent red fill.
- diagonal stripe/hatch appearance.
- closure icon/label at or near center.

### HEAVY_PENALTY

- orange outline/fill.
- optional diagonal stripe pattern.
- label `혼잡 구간`.
- route remains traversable according to backend logic.

Do not change restriction semantics.

## 9.5 Virtual vehicle marker

Use a small vehicle graphic rather than a plain dot where possible.

Selected virtual vehicle:

- highlighted halo or label.
- current route visually bound to the selected vehicle.

Keep the existing interpolation/polling behavior.

## 9.6 Route summary floating card

Add bottom-right map card:

- total distance.
- estimated duration.
- waypoint count.
- route revision/restriction revision in a secondary details line.

Use existing draft/route fields.

## 9.7 Legend

Add compact map legend for:

- virtual vehicle.
- route.
- blocked.
- congestion.
- origin/destination/waypoint if needed.

## 9.8 Assignment inbox and events

The current lists are operationally useful but visually too dense for the main mockup.

Move them into:

- collapsible lower panel, or
- `요청/이벤트` tab inside the left panel.

Important states still need to be visible:

- pending dispatch request.
- accepted/rejected.
- NO_ROUTE / blocked waiting.
- restriction conflict.
- route recalculation.

---

# 10. Workspace Switching

Preserve the current isolation between normal and virtual modes.

Required:

- normal fleet layers hidden in virtual mode.
- virtual objects hidden in normal mode.
- backend virtual simulation continues when the operator returns to normal mode.
- Live View closes cleanly before entering virtual mode.
- returning to normal mode restores the previous normal UI state.

The existing `workspace-sections.js` behavior should continue to pass tests unless the DOM architecture makes it obsolete.

If the new layout eliminates the need to hide individual normal sections, simplify this module only after equivalent regression tests are added.

---

# 11. Login UX

The current login form occupies the normal sidebar before authentication.

Change it to either:

- centered login card over a blurred/light dashboard shell, or
- modal login card.

After login:

- remove/hide login UI completely.
- show current connection state in the header.

Do not modify authentication semantics.

---

# 12. File-Level Change Plan

## `operator-web/index.html`

Restructure into:

- app header.
- left nav rail.
- normal workspace map surface.
- normal right sidebar cards.
- virtual left control panel.
- shared map container.
- floating Live View.
- login overlay/modal.

Preserve existing DOM IDs used by JavaScript whenever possible.

## `operator-web/styles.css`

Current CSS is compact and heavily coupled.

Refactor into readable sections or split into files, for example:

- `styles/tokens.css`
- `styles/shell.css`
- `styles/map.css`
- `styles/normal-dashboard.css`
- `styles/virtual-dispatch.css`
- `styles/live-view.css`
- `styles/responsive.css`

If avoiding multiple requests is preferred, keep one file but organize it with these sections.

## `operator-web/app.js`

Functional changes should be limited to UI support:

- remove/reduce splitter code.
- add current-time rendering.
- render status counts.
- add client-side vehicle search/filter.
- render structured selected-vehicle fields.
- adapt trip card visibility.
- adapt replay/live tabs.
- change Live View open/close classes for floating layout.

Do not change API endpoints.

## `operator-web/live-map.js`

Only change marker visual helpers if needed.

Preserve:

- live marker revealing.
- live map follower.
- marker positioning semantics.

## `operator-web/live-telemetry.js`

No functional redesign expected.

Only adjust presentation hooks if the new Live View status areas need different target elements/classes.

## `operator-web/replay-timeline.js`

No algorithm changes.

## `operator-web/virtual-dispatch.js`

Keep all API/simulation logic.

UI-oriented work:

- structured status output.
- improved virtual vehicle marker icon.
- improved route/restriction styles.
- route summary card.
- step section states.
- collapsible requests/events.
- road restriction mode UI synchronization.

## `operator-web/workspace-sections.js`

Retain current behavior initially.

Refactor only if normal and virtual workspace containers make per-section state restoration unnecessary.

---

# 13. Language Strategy

The reference mockups are Korean while the existing operator UI is English.

For closest visual/demo parity:

- use Korean as the default presentation language;
- keep API/state enum values unchanged;
- centralize browser labels in one JS constants module or data attributes instead of scattering strings.

Suggested visible labels:

- 일반 모니터링
- 가상 경로·배차
- 선택 차량
- 운행 생성·배정
- 운행 녹화
- 실시간 영상
- 저장된 녹화
- 시나리오 설정
- 가상 차량 설정
- 경로 및 제어
- 도로 상태 설정
- 도로 차단
- 혼잡 구간
- 경로 미리보기
- 배차 요청
- 경로 추종
- 일시정지
- 재개

An English localization can be retained later without changing DOM/API behavior.

---

# 14. Responsive Behavior

## Desktop >= 1200 px

Primary target.

Normal:

```text
header
nav rail | map | right sidebar
```

Virtual:

```text
header
virtual control panel | map
```

## Tablet 768–1199 px

- nav rail may collapse to top/bottom icons.
- right sidebar becomes 340–380 px or an overlay drawer.
- Live View uses a smaller floating card.
- virtual control panel may become a drawer.

## Mobile browser < 768 px

The operator web is not the primary presentation target, but it must remain usable:

- map on top.
- selected/virtual controls below or bottom-sheet style.
- no horizontal overflow.
- Live View full-width.

---

# 15. Accessibility / Interaction Requirements

Even for a demo-oriented redesign:

- preserve visible focus state.
- do not use color as the only status indicator.
- buttons must keep semantic `<button>` elements.
- tabs use `aria-pressed` or proper tab semantics.
- map-only selection actions must have accompanying text/status.
- modal/login focus should be contained appropriately.
- destructive recording deletion keeps explicit confirmation.
- all primary text should remain readable at 100% browser zoom and 125% OS scaling.

---

# 16. Implementation Phases

## Phase 0 — Freeze behavior and capture baseline

Before changing layout:

1. Run existing backend/frontend-related tests.
2. Capture screenshots of:
   - signed-out operator page.
   - normal workspace, no vehicle selected.
   - selected vehicle.
   - open Live View.
   - replay loaded.
   - virtual workspace.
   - virtual route preview.
   - active road restriction.
3. Record any current UI bugs separately so they are not confused with redesign regressions.

Exit condition:

- baseline behavior and screenshots are available for regression comparison.

---

## Phase 1 — Shared light design system and application shell

Implement:

- color/spacing/radius tokens.
- typography.
- header.
- workspace tabs.
- nav rail.
- cards/buttons/inputs/chips.

Do not yet rewrite data rendering.

Exit condition:

- all existing controls still operate in the new light shell.

---

## Phase 2 — Normal monitoring map + selected vehicle panel

Implement:

- map chrome.
- search.
- status filter chips.
- improved vehicle markers.
- selected vehicle card.
- route progress/summary.
- trip assignment card.
- settings relocation.

Exit condition:

- selecting a vehicle from marker or search produces the correct sidebar state and route.

---

## Phase 3 — Live View and recording redesign

Implement:

- floating Live View.
- map remains visible.
- right sidebar remains visible.
- replay card/tabs.
- compact playback controls.
- preserve overlays and timeline.

Exit condition:

- live telemetry still moves/follows the correct vehicle.
- fullscreen works.
- replay synchronization and deletion behavior still work.

---

## Phase 4 — Virtual dispatch workspace

Implement:

- dedicated left virtual control panel.
- step-based controls.
- route summary/legend.
- improved flags/vehicle marker.
- blocked/congestion visual treatment.
- requests/events collapsible panel.

Exit condition:

- complete virtual dispatch demo can be performed with no API behavior regression.

---

## Phase 5 — Visual polish and screenshot matching

Compare runtime screenshots side by side with the references.

Tune:

- panel widths.
- map/control spacing.
- typography weight.
- card radius.
- shadows.
- route thickness.
- marker size.
- live video size.
- vertical density.
- Korean wording.

Do not chase pixel-level details if they harm responsiveness or real data display.

---

# 17. Regression Test Plan

## Existing automated tests

Run at least all existing Node/Vitest tests, especially:

- workspace section restore behavior.
- tracking.
- live map/telemetry.
- recording replay.
- replay timeline.
- virtual routing/dispatch integration.
- authentication/bootstrap.

The UI redesign must not require changes to unrelated backend test expectations.

## Browser functional checklist

### Authentication

- login succeeds.
- signed-out state is clean.
- connection status updates.

### Normal monitoring

- fleet appears.
- marker status colors are correct.
- status filters work.
- search selects/recenters vehicle.
- selected vehicle data updates.
- planned route displays.
- trip creation works.
- map-point picking works.

### Live View

- button availability still follows active recording session.
- iframe opens.
- correct vehicle/session selected.
- live telemetry status updates.
- live marker follows.
- manual map drag pauses follow if current behavior requires it.
- recenter restores follow.
- close/fullscreen work.

### Recording

- load trip.
- play/pause.
- seek.
- ±10 sec.
- speed control if implemented in UI.
- detection overlay stays synchronized.
- segment gaps remain visible.
- deletion selection and confirmation work.

### Virtual dispatch

- normal/virtual switching.
- scenario create/remove.
- vehicle create/remove.
- origin/destination/waypoint placement.
- road snapping.
- preview.
- request generation.
- accept/reject.
- auto-follow per vehicle.
- pause/resume/cancel.
- speed setting.
- blocked region.
- congestion region.
- occupied-road rejection.
- restriction removal.
- route recalculation.
- switching back to normal restores normal view.

---

# 18. Visual Acceptance Criteria

The redesign is complete when:

1. The operator dashboard is recognizably the same visual product as `operator-dashboard.png`.
2. The virtual workspace is recognizably the same control/map composition as the laptop UI in `virtual-dispatch-android.png`.
3. The normal dashboard uses a light theme with blue navigation/actions and white cards.
4. The map is the dominant surface rather than the sidebar.
5. Normal selected-vehicle details occupy a clean fixed right panel.
6. Live View floats over the map and no longer replaces/hides the normal sidebar.
7. Virtual dispatch uses a dedicated left control panel.
8. Blocked and congestion regions are visually distinct at a glance.
9. No existing functional path is removed merely to simplify the mockup.
10. No fake operational data is introduced for visual similarity.
11. Android code remains untouched.

---

# 19. Suggested Work Order for a Coding Agent

Use this order to minimize regressions:

1. Read the existing operator web code before editing.
2. Create shared visual tokens.
3. Restructure `operator-web/index.html` while preserving existing IDs.
4. Make the existing JS work against the restructured DOM before adding new UI behavior.
5. Implement the light dashboard CSS.
6. Refactor Live View from split pane to floating card.
7. Add real fleet search/status filtering.
8. Restructure virtual workspace.
9. Improve map marker/route/restriction visuals.
10. Run tests.
11. Capture screenshots.
12. Perform final spacing/color/typography comparison with the two reference images.

---

# 20. Recommended Commit Breakdown

### Commit 1
`ui: add shared light dashboard design tokens and shell`

### Commit 2
`ui: redesign normal monitoring map and vehicle details`

### Commit 3
`ui: redesign trip assignment and recording panels`

### Commit 4
`ui: make live view a floating map panel`

### Commit 5
`ui: redesign virtual routing and dispatch workspace`

### Commit 6
`ui: improve map markers routes and road restriction styling`

### Commit 7
`test: add web ui regression checks and responsive polish`

---

# 21. Key Constraint for the Implementation Agent

The safest strategy is:

> **Preserve existing element IDs, event handlers, API calls, routing behavior, telemetry behavior, and streaming behavior; change the surrounding DOM structure and CSS first, then make only narrowly scoped JavaScript changes needed to support the new presentation.**

This project already contains the main functional pieces shown in the mockups. The redesign should therefore be treated as a controlled **operator web UI refactor**, not a frontend rewrite and not an Android redesign.
