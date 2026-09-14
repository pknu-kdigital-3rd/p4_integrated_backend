from app.core.settings import settings


def browser_ice_servers() -> list[dict[str, str]]:
    """Expose the TURN settings used by the browser's Go-relay connection."""
    if not (settings.TURN_URL and settings.TURN_USERNAME and settings.TURN_PASSWORD):
        return []
    return [
        {
            "urls": settings.TURN_URL,
            "username": settings.TURN_USERNAME,
            "credential": settings.TURN_PASSWORD,
        }
    ]
