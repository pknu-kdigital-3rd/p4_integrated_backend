import json

from fastapi import APIRouter
from fastapi.responses import FileResponse, HTMLResponse

from app.core.settings import BASE_DIR, INDEX_HTML_PATH, settings

router = APIRouter()

LIVE_VIEW_TRACKS_JS_PATH = BASE_DIR / "live-view-tracks.js"
LIVE_VIEW_DISTANCE_COLORS_JS_PATH = BASE_DIR / "live-view-distance-colors.js"

PARENT_ORIGINS_PLACEHOLDER = "__LIVE_VIEW_PARENT_ORIGINS__"


def parent_origins_json() -> str:
    origins = [item.strip().rstrip("/") for item in settings.LIVE_VIEW_PARENT_ORIGINS.split(",") if item.strip()]
    # Safe inside a <script> block: no "</script>" or HTML can be formed.
    return json.dumps(origins).replace("<", "\\u003c")


@router.get("/", response_class=HTMLResponse)
async def index():
    with open(INDEX_HTML_PATH, "r", encoding="utf-8") as f:
        return f.read().replace(PARENT_ORIGINS_PLACEHOLDER, parent_origins_json())


@router.get("/live-view-tracks.js")
async def live_view_tracks_js():
    # Overlay track hold/prediction logic, kept separate so it can be
    # unit-tested with node; no-cache so a page reload picks up changes.
    return FileResponse(
        LIVE_VIEW_TRACKS_JS_PATH,
        media_type="text/javascript",
        headers={"Cache-Control": "no-cache"},
    )


@router.get("/live-view-distance-colors.js")
async def live_view_distance_colors_js():
    # Keep the browser classifier available at the same explicit route as the
    # other Live View overlay helper; no-cache ensures updated settings logic loads.
    return FileResponse(
        LIVE_VIEW_DISTANCE_COLORS_JS_PATH,
        media_type="text/javascript",
        headers={"Cache-Control": "no-cache"},
    )
