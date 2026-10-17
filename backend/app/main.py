"""Orrery API: serves the launcher and reports which apps on the Pi are alive."""

from __future__ import annotations

import asyncio
import mimetypes
import os
import time
from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import host, probe, stats

# Not in every platform's table, and browsers want the right type before they will
# offer to install the app.
mimetypes.add_type("application/manifest+json", ".webmanifest")

DEFAULT_UI_DIR = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"

app = FastAPI(title="Orrery", version="0.1.0")

APPS = probe.load_apps()

# The Pi apps, with the systemd units that run and back them up.
COLLECTOR = stats.Collector(
    [
        stats.Unit(id=a["id"], unit=a["unit"], backup_unit=a.get("backup_unit"), host=urlparse(a["url"]).hostname)
        for a in probe.load_raw()
        if a.get("unit")
    ]
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/status")
async def status() -> JSONResponse:
    apps = await probe.probe_all(APPS)
    try:
        # systemctl and journalctl block, so keep them off the event loop.
        readings = await asyncio.to_thread(COLLECTOR.collect)
    except Exception:  # noqa: BLE001 - stats are a bonus; never lose the health checks over them
        readings = {}
    for app_id, s in readings.items():
        if app_id in apps:
            apps[app_id]["stats"] = s
    body = {"checked_at": int(time.time()), "host": {**host.readings(), "disk_pct": stats.disk_used_pct()}, "apps": apps}
    # Live status must never be shown from a cache as if it were current.
    return JSONResponse(body, headers={"Cache-Control": "no-store"})


def ui_directory() -> Path:
    override = os.environ.get("ORRERY_UI_DIR")
    return Path(override) if override else DEFAULT_UI_DIR


class UiFiles(StaticFiles):
    """Fingerprinted assets/ are immutable; everything else (index.html, sw.js, the
    manifest, icons) keeps its name across builds and must be revalidated."""

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        path = Path(str(args[0])) if args else Path()
        if "assets" in path.parts:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            response.headers["Cache-Control"] = "no-cache"
        return response


# Mounted last so every /api route above wins. Missing in an unbuilt checkout, which is
# fine: run the Vite dev server instead.
_ui = ui_directory()
if _ui.is_dir():
    app.mount("/", UiFiles(directory=_ui, html=True), name="ui")
