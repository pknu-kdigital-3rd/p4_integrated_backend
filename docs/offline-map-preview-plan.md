# Offline map and dashboard preview

## Goal

Make the operator dashboard's basemap colors independently editable and provide a visual preview that runs without the control API, routing, media, database, or internet after one-time asset setup. The preview covers Normal monitoring and Virtual routing & dispatch with fixture states. It keeps basic selection and layout controls, while backend actions remain disabled.

## Implementation

1. Replace the `/osm` raster base layer with a locally hosted, styleable vector basemap. Keep Leaflet overlays and use the MapLibre Leaflet adapter. Put road, land, water, and label colors in a local map style; centralize marker and route colors separately from UI CSS.
2. Provide a one-time setup script that downloads South Korea OSM source data, generates a PMTiles extract bounded to Busan (128.7–129.5 E, 34.8–35.5 N), and caches the tile archive, glyphs, and sprites outside tracked source. Serve these assets with HTTP range support in preview and deployment.
3. Bundle Leaflet, MapLibre, their adapter, and existing Leaflet plugins locally. Update the Node image to build and serve the dashboard bundle so neither runtime mode needs CDN scripts.
4. Add an explicit preview mode backed by local fixtures. Reuse the dashboard's actual rendering paths for both tabs; avoid authentication, live polling, external APIs, and media startup in preview. Backend action controls are disabled.
5. Document the one-time setup, preview command, editable color locations, attribution, and deployment asset requirement.

## Verification

- Run the preview with the real-time stack stopped and network disconnected. Both tabs, basemap, labels, vehicles, and route samples render without remote requests.
- Change one basemap color and one UI color, then confirm hot reload reflects each change.
- Check selection, resizing, attribution, and map overlays in preview. Run frontend build and existing focused tests, then smoke-test the deployed map path with the fixture asset package.

## Assumptions

- One-time downloads are permitted, but subsequent preview sessions must be fully offline.
- Preview fixtures are visual and read-only; they do not simulate trip creation, recording, or dispatch workflows.
- The local map package is limited to the Busan region.
