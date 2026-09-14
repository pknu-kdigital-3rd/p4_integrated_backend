from fastapi import APIRouter
from fastapi.responses import HTMLResponse

from app.core.settings import INDEX_HTML_PATH

router = APIRouter()


@router.get("/", response_class=HTMLResponse)
async def index():
    with open(INDEX_HTML_PATH, "r", encoding="utf-8") as f:
        return f.read()
