"""Orrery API: serves the launcher and reports which apps on the Pi are alive."""

from __future__ import annotations

import mimetypes
import os
import time
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import host, probe

# Not in every platform's table, and browsers want the right type before they will
# offer to install the app.
mimetypes.add_type("application/manifest+json", ".webmanifest")

DEFAULT_UI_DIR = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"

app = FastAPI(title="Orrery", version="0.1.0")

APPS = probe.load_apps()


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/status")
async def status() -> JSONResponse:
    apps = await probe.probe_all(APPS)
    body = {"checked_at": int(time.time()), "host": host.readings(), "apps": apps}
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
