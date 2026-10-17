"""A few readings from the Pi itself, for the HUD. Each one is None where /proc or /sys
don't have it, which is every reading on the laptop."""

from __future__ import annotations

import os
from pathlib import Path


def _read(path: str) -> str | None:
    try:
        return Path(path).read_text()
    except OSError:
        return None


def cpu_temp_c() -> float | None:
    raw = _read("/sys/class/thermal/thermal_zone0/temp")
    return round(int(raw) / 1000, 1) if raw else None


def uptime_s() -> int | None:
    raw = _read("/proc/uptime")
    return int(float(raw.split()[0])) if raw else None


def mem_used_pct() -> int | None:
    raw = _read("/proc/meminfo")
    if not raw:
        return None
    fields = {line.split(":")[0]: int(line.split()[1]) for line in raw.splitlines() if ":" in line}
    total, available = fields.get("MemTotal"), fields.get("MemAvailable")
    if not total or available is None:
        return None
    return round(100 * (total - available) / total)


def load1() -> float | None:
    try:
        return round(os.getloadavg()[0], 2)
    except OSError:
        return None


def readings() -> dict:
    return {
        "temp_c": cpu_temp_c(),
        "uptime_s": uptime_s(),
        "mem_used_pct": mem_used_pct(),
        "load1": load1(),
    }
