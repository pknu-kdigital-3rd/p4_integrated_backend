# Operator UI redesign status

Implemented from `ITS_OPERATOR_WEB_UI_REDESIGN_PLAN.md` and the two images in
`docs/ui-mockups/`.

## Changes

- Light design tokens, Korean primary labels, local SVG icons, workspace tabs,
  browser clock, and navigation rail. Alerts and statistics are disabled until
  backed by real data.
- Fixed monitoring sidebar with vehicle details, trip assignment, expandable
  advanced fields, and recording cards. Telemetry settings open from the rail.
- Fleet search by vehicle name, code, ID, and telemetry external ID. Status
  counts and marker filters use actual fleet data; unrecognized states are
  shown as unknown. Stale fleet markers are removed on refresh.
- Vehicle icons, selected marker halo/label, blue planned routes, and a legend.
- Floating Live View that retains the map and sidebar, including existing
  iframe messaging, telemetry following, recenter, and fullscreen controls.
- Live/recorded tabs, replay speed selection, and recording deletion inside a
  management disclosure. Existing timeline and detection-overlay logic remains.
- Separate virtual control panel with four numbered setup sections, road-state
  buttons, hatched regions, vehicle icons, route summary, and collapsible
  requests/events. Normal/virtual layer isolation remains in place.
- Responsive stacking and keyboard focus treatment, including sign-in focus
  containment. Android and backend API implementations were not changed.

## Validation

- 33 tests pass across dashboard presentation, workspace restoration, live map,
  live telemetry, replay timeline, recording replay/schema, foreground resume,
  and JWT helper suites.
- JavaScript syntax and diff whitespace checks pass.
- DOM inspection confirms every original ID except `layout-splitter` remains,
  no IDs are duplicated, and all literal ID selectors resolve.
- The full baseline Node run had 14 failed tests and 15 skipped tests, with
  database integration failures and additional failing vendor suites. These
  failures occurred before the redesign.
- Runtime screenshot comparison and live service workflows remain unverified:
  this session has no connected browser. No screenshots were fabricated.

## Deployment

This checkout serves `operator-web/` directly from Express. Development Compose
bind-mounts that directory. Sync the changed files to the development host and
hard-refresh `/operator/`. Production requires rebuilding the Node image.
