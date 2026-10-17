import asyncio
import time

import httpx
from fastapi.testclient import TestClient

from app import main, probe

APPS = [
    probe.App(id="ok", port=1, health="/api/health", url="https://ok.example"),
    probe.App(id="hung", port=2, health="/api/health", url="https://hung.example"),
    probe.App(id="gateway", port=3, health="/api/health", url="https://gateway.example"),
    probe.App(id="mcp", port=4, health="/mcp", url="https://mcp.example/mcp"),
]


class FakeApps(httpx.AsyncBaseTransport):
    async def handle_async_request(self, request):
        port = request.url.port
        if port == 2:
            await asyncio.sleep(30)
        code = {1: 200, 3: 502, 4: 404}[port]
        return httpx.Response(code)


def run(apps):
    return asyncio.run(probe.probe_all(apps, transport=FakeApps()))


def test_invariant_1_a_hung_app_reports_down_within_the_time_limit_and_others_still_report():
    started = time.perf_counter()
    result = run(APPS)
    assert time.perf_counter() - started < probe.PROBE_TIMEOUT + 1
    assert result["hung"]["up"] is False
    assert result["ok"]["up"] is True


def test_invariant_2_a_5xx_is_down_and_any_other_answer_is_up():
    result = run(APPS)
    assert result["gateway"]["up"] is False
    assert result["mcp"]["up"] is True


def test_invariant_3_status_is_never_cacheable(monkeypatch):
    async def fake_probe_all(apps):
        return {}

    monkeypatch.setattr(probe, "probe_all", fake_probe_all)
    response = TestClient(main.app).get("/api/status")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"


def test_invariant_4_every_app_in_the_registry_has_what_the_launcher_needs():
    apps = probe.load_apps()
    assert len({a.id for a in apps}) == len(apps)
    for a in apps:
        assert a.url.startswith("https://")
        # Pi apps are probed on loopback, so they need a port and a path to ask.
        if a.port is not None:
            assert a.health.startswith("/")


def test_invariant_5_an_app_off_the_pi_is_probed_at_its_public_url_and_pi_apps_on_loopback():
    away = probe.App(id="away", port=None, health="", url="https://example.github.io/away/")
    home = probe.App(id="home", port=8010, health="/api/health", url="https://home.example")
    assert probe.probe_url(away) == "https://example.github.io/away/"
    assert probe.probe_url(home) == "http://127.0.0.1:8010/api/health"


SHOW = """Id=recipes.service
ActiveState=active
CPUUsageNSec=2000000000
NRestarts=0
MemoryCurrent=[not set]

Id=recipes-backup.service
ActiveState=inactive
Result=success
CPUUsageNSec=
"""


def test_invariant_8_each_unit_gets_its_own_block_and_missing_values_are_none_not_zero():
    from app import stats

    shown = stats.parse_show(SHOW)
    assert shown["recipes.service"]["CPUUsageNSec"] == "2000000000"
    assert shown["recipes.service"]["MemoryCurrent"] is None
    assert shown["recipes-backup.service"]["Result"] == "success"
    assert shown["recipes-backup.service"]["CPUUsageNSec"] is None


def test_invariant_9_cpu_is_a_rate_between_samples_and_never_invented():
    from app import stats

    meter = stats.CpuMeter()
    assert meter.sample("recipes", 1_000_000_000, now=100.0) is None  # nothing to compare yet
    assert meter.sample("recipes", 1_500_000_000, now=110.0) == 5.0  # 0.5s of CPU in 10s
    assert meter.sample("recipes", 100, now=120.0) is None  # counter went back: it restarted


def test_invariant_10_status_still_reports_health_when_stats_fail(monkeypatch):
    async def fake_probe_all(apps):
        return {"recipes": {"up": True, "ms": 3}}

    def broken():
        raise RuntimeError("no systemd here")

    monkeypatch.setattr(probe, "probe_all", fake_probe_all)
    monkeypatch.setattr(main.COLLECTOR, "collect", broken)
    response = TestClient(main.app).get("/api/status")
    assert response.status_code == 200
    assert response.json()["apps"]["recipes"] == {"up": True, "ms": 3}
