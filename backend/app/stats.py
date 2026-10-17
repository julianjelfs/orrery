"""What each app on the Pi is doing: CPU, memory, uptime, restarts, backups, errors and
its certificate. Everything here is readable by the user Orrery runs as, so it needs no
root.

Off the Pi (on the laptop) systemctl and /proc aren't there, and every reading comes back
None rather than failing the status call.
"""

from __future__ import annotations

import os
import socket
import ssl
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

PROPS = [
    "Id",
    "ActiveState",
    "MainPID",
    "CPUUsageNSec",
    "TasksCurrent",
    "NRestarts",
    "ActiveEnterTimestampMonotonic",
    "Result",
    "ExecMainExitTimestampMonotonic",
]

# Slow-changing readings are cached rather than fetched on every 10-second poll.
ERRORS_TTL = 5 * 60
CERT_TTL = 6 * 60 * 60


@dataclass(frozen=True)
class Unit:
    id: str
    unit: str
    backup_unit: str | None
    host: str | None


def parse_show(text: str) -> dict[str, dict[str, str | None]]:
    """Split `systemctl show a b c` output into one dict per unit, keyed by its Id.

    Units are separated by blank lines. systemd prints "[not set]" or "" for a property
    it doesn't have; both become None so nothing downstream mistakes them for zero.
    """
    units: dict[str, dict[str, str | None]] = {}
    for block in text.strip().split("\n\n"):
        props: dict[str, str | None] = {}
        for line in block.splitlines():
            key, _, value = line.partition("=")
            props[key] = None if value in ("", "[not set]") else value
        if props.get("Id"):
            units[props["Id"]] = props
    return units


def to_int(value: str | None) -> int | None:
    try:
        return int(value) if value is not None else None
    except ValueError:
        return None


class CpuMeter:
    """CPU % from systemd's cumulative counter: the difference between two samples over
    the wall time between them, as a percentage of one core (like top).

    The first sample has nothing to compare with, and a counter that went down means the
    service restarted; both give None rather than an invented number."""

    def __init__(self) -> None:
        self.last: dict[str, tuple[int, float]] = {}

    def sample(self, unit: str, cpu_ns: int | None, now: float) -> float | None:
        if cpu_ns is None:
            self.last.pop(unit, None)
            return None
        previous = self.last.get(unit)
        self.last[unit] = (cpu_ns, now)
        if previous is None:
            return None
        prev_ns, prev_at = previous
        elapsed = now - prev_at
        if cpu_ns < prev_ns or elapsed <= 0:
            return None
        return round(100 * (cpu_ns - prev_ns) / 1e9 / elapsed, 1)


def monotonic_now_s() -> float | None:
    try:
        return float(Path("/proc/uptime").read_text().split()[0])
    except (OSError, ValueError, IndexError):
        return None


def memory_mb(unit: str) -> float | None:
    """Resident memory of every process in the unit's cgroup. systemd's MemoryCurrent is
    empty on the Pi because Raspberry Pi OS boots with the memory controller off."""
    procs = Path(f"/sys/fs/cgroup/system.slice/{unit}.service/cgroup.procs")
    try:
        pids = procs.read_text().split()
    except OSError:
        return None
    total_kb = 0
    for pid in pids:
        try:
            for line in Path(f"/proc/{pid}/status").read_text().splitlines():
                if line.startswith("VmRSS:"):
                    total_kb += int(line.split()[1])
                    break
        except (OSError, ValueError):
            continue
    return round(total_kb / 1024, 1)


def disk_used_pct() -> int | None:
    try:
        s = os.statvfs("/")
    except OSError:
        return None
    total = s.f_blocks * s.f_frsize
    free = s.f_bavail * s.f_frsize
    return round(100 * (total - free) / total) if total else None


def systemctl_show(names: list[str]) -> dict[str, dict[str, str | None]]:
    try:
        out = subprocess.run(
            ["systemctl", "show", *names, "-p", ",".join(PROPS)],
            capture_output=True,
            text=True,
            timeout=3,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return {}
    return parse_show(out)


def journal_errors_24h(unit: str) -> int | None:
    try:
        out = subprocess.run(
            ["journalctl", "-u", unit, "-p", "err", "--since", "-24h", "-q", "-o", "cat", "--no-pager"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    return len([line for line in out.stdout.splitlines() if line.strip()])


def cert_days_left(host: str) -> int | None:
    """Ask Caddy on loopback for the certificate it serves for `host`."""
    context = ssl.create_default_context()
    try:
        with socket.create_connection(("127.0.0.1", 443), timeout=2) as raw:
            with context.wrap_socket(raw, server_hostname=host) as tls:
                cert = tls.getpeercert()
    except (OSError, ssl.SSLError):
        return None
    expires = datetime.strptime(cert["notAfter"], "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
    return (expires - datetime.now(timezone.utc)).days


class Collector:
    def __init__(self, units: list[Unit]) -> None:
        self.units = units
        self.cpu = CpuMeter()
        self.cache: dict[tuple[str, str], tuple[float, int | None]] = {}

    def cached(self, kind: str, key: str, ttl: float, fetch) -> int | None:
        hit = self.cache.get((kind, key))
        now = time.monotonic()
        if hit and now - hit[0] < ttl:
            return hit[1]
        value = fetch()
        self.cache[(kind, key)] = (now, value)
        return value

    def collect(self) -> dict[str, dict]:
        names = [f"{u.unit}.service" for u in self.units]
        names += [f"{u.backup_unit}.service" for u in self.units if u.backup_unit]
        shown = systemctl_show(names)
        up_now = monotonic_now_s()
        now = time.monotonic()
        out: dict[str, dict] = {}
        for u in self.units:
            props = shown.get(f"{u.unit}.service")
            if not props:
                continue
            entered = to_int(props.get("ActiveEnterTimestampMonotonic"))
            running = props.get("ActiveState") == "active"
            stats: dict = {
                "state": props.get("ActiveState"),
                "cpu_pct": self.cpu.sample(u.unit, to_int(props.get("CPUUsageNSec")), now),
                "mem_mb": memory_mb(u.unit) if running else None,
                "tasks": to_int(props.get("TasksCurrent")),
                "restarts": to_int(props.get("NRestarts")),
                "uptime_s": int(up_now - entered / 1e6) if running and up_now and entered else None,
                "errors_24h": self.cached("errors", u.unit, ERRORS_TTL, lambda: journal_errors_24h(u.unit)),
                "cert_days": self.cached("cert", u.host, CERT_TTL, lambda: cert_days_left(u.host)) if u.host else None,
                "backup": None,
            }
            backup = shown.get(f"{u.backup_unit}.service") if u.backup_unit else None
            if backup:
                exited = to_int(backup.get("ExecMainExitTimestampMonotonic"))
                stats["backup"] = {
                    "ok": backup.get("Result") == "success",
                    "age_s": int(up_now - exited / 1e6) if up_now and exited else None,
                }
            out[u.id] = stats
        return out
