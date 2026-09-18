from fastapi import APIRouter, Depends, HTTPException

from app.core.state import AppState, get_app_state
from app.services.telemetry import TelemetryBatchIn, TelemetryIdentityError

router = APIRouter()


# Same-host relay -> Vision call, like /internal/android-live. If this port is
# ever exposed beyond loopback, add a service token or network restriction.
@router.post("/internal/telemetry")
async def ingest_telemetry(batch: TelemetryBatchIn, state: AppState = Depends(get_app_state)):
    """Store one relay-validated GPS/IMU batch. Returns immediately: this only
    updates bounded in-memory history and never runs inference."""

    try:
        state.telemetry_store.ingest(batch)
    except TelemetryIdentityError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"status": "ok", "gps": len(batch.gps), "imu": len(batch.imu)}
