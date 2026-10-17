"""Ask each app whether it is alive.

Every app runs on this same Pi, so the probe goes straight at its loopback port and
skips Caddy, DNS and TLS. Probes run side by side with a short time limit each, so one
hung app costs the page at most PROBE_TIMEOUT, never the sum of them.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path

import httpx

PROBE_TIMEOUT = 1.5

APPS_FILE = Path(__file__).resolve().parent.parent.parent / "apps.json"


@dataclass(frozen=True)
class App:
    id: str
    port: int | None
    health: str
    url: str


def load_apps(path: Path = APPS_FILE) -> list[App]:
    raw = json.loads(path.read_text())
    return [App(id=a["id"], port=a.get("port"), health=a["health"], url=a["url"]) for a in raw]


def probe_url(app: App) -> str:
    # An app that isn't on the Pi (Askance, on GitHub Pages) has no port: ask it by URL.
    if app.port is None:
        return f"{app.url}{app.health}"
    # On the laptop nothing listens on these ports, so ORRERY_PROBE_PUBLIC=1 asks the
    # real names instead. Handy at home while working on the UI.
    if os.environ.get("ORRERY_PROBE_PUBLIC"):
        base = app.url.removesuffix("/mcp")
        return f"{base}{app.health}"
    return f"http://127.0.0.1:{app.port}{app.health}"


def is_up(status_code: int) -> bool:
    # Anything below 500 means a process answered. A 404 from the MCP server's GET is
    # still a live server; 502-504 would be a proxy answering for a dead one.
    return status_code < 500


async def probe_one(client: httpx.AsyncClient, app: App) -> dict:
    started = time.perf_counter()
    try:
        # httpx's timeout is per read, so a server dribbling bytes could outlast it.
        # wait_for caps the whole exchange.
        response = await asyncio.wait_for(client.get(probe_url(app)), PROBE_TIMEOUT)
    except (httpx.HTTPError, OSError, asyncio.TimeoutError):
        return {"up": False, "ms": None}
    ms = round((time.perf_counter() - started) * 1000)
    return {"up": is_up(response.status_code), "ms": ms}


async def probe_all(apps: list[App], transport: httpx.AsyncBaseTransport | None = None) -> dict:
    async with httpx.AsyncClient(transport=transport, follow_redirects=False) as client:
        results = await asyncio.gather(*(probe_one(client, a) for a in apps))
    return {a.id: r for a, r in zip(apps, results)}
