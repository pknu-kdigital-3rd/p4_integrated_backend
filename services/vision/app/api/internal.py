import asyncio

import httpx
from pydantic import BaseModel
from fastapi import APIRouter, Depends

from app.core.settings import settings
from app.core.state import AppState, get_app_state

router = APIRouter()


class AndroidLiveUpdate(BaseModel):
    live: bool


@router.post("/internal/android-live")
async def update_android_live(
    update: AndroidLiveUpdate, state: AppState = Depends(get_app_state)
):
    async with state.result_condition:
        state.android_live = update.live
        state.result_condition.notify_all()
    return {"android_live": state.android_live}


async def sync_android_live_from_relay(state: AppState) -> None:
    """Ask the Go relay for the CURRENT publisher status at startup.

    Without this, a Python restart while Android is already streaming loses
    android_live entirely: Go only pushes /internal/android-live on
    connect/disconnect edges (see relay-go's Broadcaster.onLive), not as a
    periodic heartbeat, so a fresh Python process has no way to learn
    Android is already live until the next edge transition - which may
    never come. Every browser reconnect then immediately sees
    android_live=false and loops reconnecting for nothing.

    Retries indefinitely rather than a few quick attempts - the three-tries
    version gave up permanently if the relay happened to still be starting
    up too, which broke the "doesn't matter which of the two starts first"
    goal: with no future edge coming (Android was already live before this
    process existed), a one-shot give-up meant android_live stayed wrong for
    the rest of this process's life.
    """
    while True:
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                response = await client.get(settings.RELAY_STATUS_URL)
                response.raise_for_status()
                live = bool(response.json().get("live", False))
            async with state.result_condition:
                state.android_live = live
                state.result_condition.notify_all()
            return
        except httpx.HTTPError:
            await asyncio.sleep(0.5)
