# Orrery

The launcher for every app in the house. Each app is a planet orbiting a glowing core,
which is the Pi. Click one and the camera warps into it and opens the app.

- Apps on the Pi orbit inside the asteroid belt. Apps hosted elsewhere (Askance and All
  Ears, on GitHub Pages) swing round outside it on tilted orbits.
- Every 10 seconds the Pi checks each app and fires a packet from the core to every
  planet. A planet that answers flashes. One that doesn't goes grey, cracks and flickers
  red, and its halo turns red.
- The top right shows the Pi's own readings: CPU temperature (with a sparkline), load,
  memory, disk and uptime.
- Each app on the Pi reports what systemd and `/proc` say about it: CPU, memory, uptime,
  when its last backup ran and whether it worked, errors in its journal over the last 24
  hours, restarts, and how long its certificate has left. A busy app spins faster. One with
  something to look at (a failed or stale backup, errors, restarts, a certificate under 14
  days) flares amber, and the warning shows in the focus panel and on the phone list.
  None of this needs root: Orrery's user can read it all. Memory is summed from the
  processes' RSS, because the Pi boots with the memory cgroup off.
- Hover a planet and time slows down. Drag to spin the system, scroll to zoom, press 1 to
  7 to pick one and Enter to go. On a phone, the first tap shows what a planet is and the
  second launches it.
- The Garmin MCP server is a small moon with a satellite. It has no UI, so clicking it
  copies its endpoint.

## Where it runs

On the Pi, behind Caddy, at https://apps.julianjelfs.co.uk. That one URL works at home and
on any tailnet device with subnet routes on.

Off both, the installed app still opens from its service worker. It says the Pi is out of
reach, shows every Pi app's status as unknown rather than whatever it was last time, and
asks the GitHub-hosted apps directly whether they're up.

## Opening installed apps

Installed on Android, Orrery opens each app through an `intent://` link rather than its
plain URL, so Android hands it to that app's installed PWA instead of Chrome showing it in
a Custom Tab inside Orrery. iOS has no way for one home screen web app to open another, so
there an app opens in the in-app browser sheet. In a browser tab it's a normal link
everywhere.

## Adding an app

Add an entry to `apps.json`. The backend and the frontend both read it.

- `unit` and `backup_unit`: the systemd services that run and back up a Pi app, for its
  stats. Leave them out and the app gets a health check only.
- `port` and `health`: the app's loopback port and health path on the Pi. Leave `port` out
  for an app that isn't on the Pi; the Pi then asks `url` + `health` instead.
- `host`: `pi` puts it inside the belt, anything else outside.
- `style`: the planet's surface. One of `lava`, `strings`, `ice`, `honeycomb`, `moon`,
  `values`, `waves`. Each is a branch in `planetFragment` in `frontend/src/lib/glsl.ts`.
- `kind`: `service` copies the URL instead of opening it.

Then `orrery rebuild`.

## Layout

- `backend/`: FastAPI. Serves the built frontend, `/api/health`, and `/api/status`, which
  probes every app side by side with a 1.5 second limit each.
- `frontend/`: Vite, Svelte 5 and three.js. `src/lib/scene.ts` is the 3D scene,
  `src/lib/glsl.ts` its shaders, `src/App.svelte` the HUD.
- `deploy/`: the systemd unit and the install script. No backup timer: Orrery keeps no
  data.
- `scripts/orrery`: drives the Pi over SSH. `orrery status`, `orrery rebuild`,
  `orrery logs`.

## Developing

```
cd backend && ORRERY_PROBE_PUBLIC=1 uv run uvicorn app.main:app --port 8050
cd frontend && npm run dev     # http://localhost:5180, proxies /api to 8050
```

`ORRERY_PROBE_PUBLIC=1` makes the backend ask each app at its real URL, since nothing
listens on the Pi's ports on the laptop.

## Invariants

1. A hung app reports down within the probe limit, and the other apps still report.
   `test_invariant_1_...` in `backend/tests/test_status.py`.
2. A 5xx counts as down. Any other answer, including the MCP server's 404, counts as up.
   `test_invariant_2_...`.
3. `/api/status` is sent with `Cache-Control: no-store`, so live status is never served
   from a cache. `test_invariant_3_...`.
4. Every app in `apps.json` has a unique id and an https URL, and every Pi app has a health
   path. `test_invariant_4_...`.
5. Apps off the Pi are probed at their public URL, Pi apps on loopback.
   `test_invariant_5_...`.
6. With no fresh report from the Pi, no app shows as up or down on the Pi's say-so.
   `invariant 6` tests in `frontend/src/lib/apps.test.ts`.
7. Installed on Android, an app opens through an Android VIEW intent that falls back to its
   URL. Anywhere else it opens at its plain URL. `invariant 7` tests in
   `frontend/src/lib/apps.test.ts`.
8. Each systemd unit's readings come from its own block of `systemctl show`, and a value
   systemd doesn't have is missing, not zero. `test_invariant_8_...` in
   `backend/tests/test_status.py`.
9. CPU % is the rate between two samples; the first sample and a counter that went
   backwards (a restart) give no number rather than a made-up one. `test_invariant_9_...`.
10. If collecting stats fails, `/api/status` still reports every app's health.
    `test_invariant_10_...`.
11. A failed or stale backup, journal errors, restarts and a certificate under 14 days are
    each flagged, and missing readings are not. `invariant 11` tests in
    `frontend/src/lib/apps.test.ts`.

```
cd backend && uv run pytest
cd frontend && npm test
```
