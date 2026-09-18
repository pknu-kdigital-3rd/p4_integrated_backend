import json

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

from app.core.settings import INDEX_HTML_PATH, settings

router = APIRouter()

PARENT_ORIGINS_PLACEHOLDER = "__LIVE_VIEW_PARENT_ORIGINS__"


def parent_origins_json() -> str:
    origins = [item.strip().rstrip("/") for item in settings.LIVE_VIEW_PARENT_ORIGINS.split(",") if item.strip()]
    # Safe inside a <script> block: no "</script>" or HTML can be formed.
    return json.dumps(origins).replace("<", "\\u003c")


@router.get("/", response_class=HTMLResponse)
async def index():
    with open(INDEX_HTML_PATH, "r", encoding="utf-8") as f:
        return f.read().replace(PARENT_ORIGINS_PLACEHOLDER, parent_origins_json())
