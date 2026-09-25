import os
from typing import Any
import httpx

BASE_URL = "http://supervisor/core/api"
TOKEN = os.environ.get("SUPERVISOR_TOKEN", "")


def _headers() -> dict[str, str]:
    if not TOKEN:
        raise RuntimeError("SUPERVISOR_TOKEN is not available. Is homeassistant_api enabled?")
    return {
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": "application/json",
    }


async def get_state(entity_id: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(f"{BASE_URL}/states/{entity_id}", headers=_headers())
        r.raise_for_status()
        return r.json()


async def call_service(domain: str, service: str, data: dict[str, Any]) -> Any:
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(
            f"{BASE_URL}/services/{domain}/{service}",
            headers=_headers(),
            json=data,
        )
        r.raise_for_status()
        return r.json()
