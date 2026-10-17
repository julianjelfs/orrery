<script lang="ts">
  import { onMount } from 'svelte';
  import { createScene, type OrreryScene } from './lib/scene';
  import {
    APPS,
    fetchStatus,
    probeDirect,
    statusesFrom,
    type HostReadings,
    type Status,
    type StatusReport
  } from './lib/apps';

  const POLL_MS = 10_000;
  // After a miss, leave the network alone for a while rather than hammering a Pi that
  // isn't there (or an address on someone else's wifi that hangs).
  const BACKOFF_MS = 30_000;

  let canvas: HTMLCanvasElement;
  let scene: OrreryScene | null = null;
  let noGL = $state(false);

  let report = $state<StatusReport | null>(null);
  let piReachable = $state<boolean | null>(null);
  let direct = $state<Set<string>>(new Set());
  let lastCheck = $state<number | null>(null);
  let temps = $state<number[]>([]);
  let now = $state(Date.now());

  let hovered = $state<string | null>(null);
  let selected = $state<string | null>(null);
  let launching = $state<string | null>(null);
  let flash = $state(false);
  let toast = $state<string | null>(null);
  let ready = $state(false);

  const labels: Record<string, HTMLElement> = {};
  const coarse = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

  let statuses = $derived<Record<string, Status>>(statusesFrom(report, APPS, direct));
  let focusId = $derived(hovered ?? selected);
  let focus = $derived(APPS.find((a) => a.id === focusId) ?? null);
  let focusIndex = $derived(focus ? APPS.indexOf(focus) : -1);
  let host = $derived<HostReadings | null>(report?.host ?? null);
  let upCount = $derived(Object.values(statuses).filter((s) => s === 'up').length);
  let downCount = $derived(Object.values(statuses).filter((s) => s === 'down').length);

  // Read the values before touching scene: with scene still null, `scene?.f(x)` never
  // evaluates x, so the effect would track nothing and never run again.
  $effect(() => {
    const s = statuses;
    const reachable = piReachable;
    scene?.setStatus(s, reachable);
  });
  $effect(() => {
    const id = selected;
    scene?.highlight(id);
  });

  const pad = (n: number) => String(n).padStart(2, '0');

  // Letters animate one by one, but lines may only break between words.
  function words(name: string) {
    let start = 0;
    return name.split(' ').map((w) => {
      const word = { chars: w.split(''), start };
      start += w.length + 1;
      return word;
    });
  }
  const clock = $derived.by(() => {
    const d = new Date(now);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  });
  function uptime(s: number | null) {
    if (s == null) return '--';
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${pad(h)}h` : `${pad(h)}h ${pad(m)}m`;
  }
  const sinceCheck = $derived(lastCheck == null ? null : Math.max(0, Math.round((now - lastCheck) / 1000)));

  const spark = $derived.by(() => {
    if (temps.length < 2) return '';
    const lo = Math.min(...temps) - 1;
    const hi = Math.max(...temps) + 1;
    return temps.map((t, i) => `${(i / (temps.length - 1)) * 60},${16 - ((t - lo) / (hi - lo)) * 16}`).join(' ');
  });

  function statusText(id: string) {
    const s = statuses[id];
    const ms = report?.apps[id]?.ms;
    if (s === 'up') return ms != null ? `Online · ${ms} ms` : 'Online';
    if (s === 'down') return 'Not answering';
    return 'Status unknown';
  }

  async function poll() {
    const next = await fetchStatus();
    if (next) {
      report = next;
      piReachable = true;
      direct = new Set();
      lastCheck = Date.now();
      if (next.host.temp_c != null) temps = [...temps.slice(-29), next.host.temp_c];
      scene?.pulse();
      return POLL_MS;
    }
    report = null;
    piReachable = false;
    direct = await probeDirect(APPS);
    return BACKOFF_MS;
  }

  function showToast(text: string) {
    toast = text;
    setTimeout(() => (toast = null), 2600);
  }

  async function launch(id: string) {
    const app = APPS.find((a) => a.id === id);
    if (!app || launching) return;
    if (app.kind === 'service') {
      try {
        await navigator.clipboard.writeText(app.url);
        showToast('Endpoint copied');
      } catch {
        showToast(app.url);
      }
      scene?.ping(id);
      return;
    }
    launching = id;
    selected = id;
    await scene?.launch(id);
    flash = true;
    setTimeout(() => window.location.assign(app.url), scene ? 140 : 0);
  }

  function choose(id: string | null) {
    if (!id) {
      selected = null;
      return;
    }
    // On a touch screen the first tap shows what it is; the second goes.
    if (coarse && selected !== id) {
      selected = id;
      return;
    }
    launch(id);
  }

  function onKey(e: KeyboardEvent) {
    if (launching) return;
    const i = APPS.findIndex((a) => a.id === (selected ?? hovered));
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      selected = APPS[(i + 1 + APPS.length) % APPS.length].id;
      e.preventDefault();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      selected = APPS[(i - 1 + APPS.length) % APPS.length].id;
      e.preventDefault();
    } else if (e.key === 'Enter' && selected && !(e.target instanceof HTMLAnchorElement)) {
      launch(selected);
    } else if (e.key === 'Escape') {
      selected = null;
    } else if (/^[1-9]$/.test(e.key) && APPS[Number(e.key) - 1]) {
      selected = APPS[Number(e.key) - 1].id;
    }
  }

  // Cursor: a ring that trails the mouse and swells over a world.
  let cursor = $state<HTMLDivElement>();
  let cx = 0, cy = 0, tx = -100, ty = -100;

  onMount(() => {
    try {
      scene = createScene(canvas, APPS, {
        onHover: (id) => (hovered = id),
        onSelect: choose,
        onLabel: (id, x, y, visible) => {
          const el = labels[id];
          if (!el) return;
          el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
          el.style.opacity = visible ? '' : '0';
        }
      });
    } catch (err) {
      console.error('[orrery] no WebGL', err);
      noGL = true;
    }
    requestAnimationFrame(() => (ready = true));

    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const loop = async () => {
      const wait = await poll();
      if (!stopped) timer = setTimeout(loop, wait);
    };
    loop();
    const tick = setInterval(() => (now = Date.now()), 1000);

    // Coming back with the back button restores this page from the bfcache mid-warp.
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) {
        scene?.reset();
        flash = false;
        launching = null;
      }
    };
    window.addEventListener('pageshow', onShow);

    let craf = 0;
    const moveCursor = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') {
        tx = e.clientX;
        ty = e.clientY;
      }
    };
    const cursorLoop = () => {
      cx += (tx - cx) * 0.22;
      cy += (ty - cy) * 0.22;
      if (cursor) cursor.style.transform = `translate3d(${cx}px, ${cy}px, 0)`;
      craf = requestAnimationFrame(cursorLoop);
    };
    if (!coarse) {
      window.addEventListener('pointermove', moveCursor);
      cursorLoop();
    }

    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(tick);
      cancelAnimationFrame(craf);
      window.removeEventListener('pageshow', onShow);
      window.removeEventListener('pointermove', moveCursor);
      scene?.dispose();
    };
  });
</script>

<svelte:window onkeydown={onKey} />

<main class:ready class:nogl={noGL} class:launching={!!launching}>
  <canvas bind:this={canvas} aria-hidden="true"></canvas>

  <div class="labels" aria-hidden="true">
    {#each APPS as app, i (app.id)}
      <div
        class="label"
        class:on={focusId === app.id}
        class:down={statuses[app.id] === 'down'}
        bind:this={labels[app.id]}
        style="--c: {app.color}"
      >
        <span class="tick"></span>
        <span class="tag">{pad(i + 1)} {app.name}</span>
      </div>
    {/each}
  </div>

  <div class="frame" aria-hidden="true">
    <i class="tl"></i><i class="tr"></i><i class="bl"></i><i class="br"></i>
  </div>

  <header class="brand">
    <h1 aria-label="Orrery">
      {#each 'ORRERY'.split('') as ch, i}
        <span style="--i: {i}">{ch}</span>
      {/each}
    </h1>
    <p>House systems · julianjelfs.co.uk</p>
  </header>

  <aside class="telemetry" aria-label="The Pi">
    <div class="clock">{clock}</div>
    <dl>
      <div><dt>Node</dt><dd>pi · 192.168.68.69</dd></div>
      <div>
        <dt>Core</dt>
        <dd>
          {host?.temp_c != null ? `${host.temp_c.toFixed(1)}°C` : '--'}
          {#if spark}
            <svg viewBox="0 0 60 16" class="spark" aria-hidden="true"><polyline points={spark} /></svg>
          {/if}
        </dd>
      </div>
      <div><dt>Load</dt><dd>{host?.load1 ?? '--'}</dd></div>
      <div><dt>Mem</dt><dd>{host?.mem_used_pct != null ? `${host.mem_used_pct}%` : '--'}</dd></div>
      <div><dt>Up</dt><dd>{uptime(host?.uptime_s ?? null)}</dd></div>
      <div>
        <dt>Link</dt>
        <dd class:bad={piReachable === false}>
          {#if piReachable === null}acquiring…{:else if piReachable}live · {sinceCheck}s{:else}lost{/if}
        </dd>
      </div>
    </dl>
  </aside>

  {#if piReachable === false}
    <div class="offline" role="status">
      <strong>The Pi is out of reach.</strong>
      Its apps' status is unknown. Any you've installed still open from their own offline copies.
    </div>
  {/if}

  <section class="focus" aria-live="polite">
    {#if focus}
      {#key focus.id}
        <div class="focus-inner" style="--c: {focus.color}">
          <div class="meta">
            <span>{pad(focusIndex + 1)} / {pad(APPS.length)}</span>
            <span class="host">{focus.host === 'pi' ? 'On the Pi' : 'GitHub Pages'}</span>
            <span class="status s-{statuses[focus.id]}"><b></b>{statusText(focus.id)}</span>
          </div>
          <h2 class:long={focus.name.length > 14}>
            {#each words(focus.name) as word}
              <span class="word">
                {#each word.chars as ch, j}<span class="ch" style="--i: {word.start + j}">{ch}</span>{/each}
              </span>
            {/each}
          </h2>
          <p class="blurb">{focus.blurb}</p>
          <button class="go" onclick={() => launch(focus.id)}>
            {focus.kind === 'service' ? 'Copy endpoint' : coarse ? 'Launch' : 'Click to launch'}
            <kbd>↵</kbd>
          </button>
        </div>
      {/key}
    {:else}
      <div class="focus-inner idle">
        <div class="meta">
          <span>{APPS.length} worlds</span>
          <span class="status s-up"><b></b>{upCount} online</span>
          {#if downCount}<span class="status s-down"><b></b>{downCount} down</span>{/if}
        </div>
        <h2 class="idle-title">Pick a world.</h2>
        <p class="blurb">{coarse ? 'Tap a planet. Drag to spin the system.' : 'Hover a planet, drag to spin, scroll to zoom, or press 1 to ' + APPS.length + '.'}</p>
      </div>
    {/if}
  </section>

  <nav class="dock" aria-label="Apps">
    {#each APPS as app, i (app.id)}
      <a
        href={app.url}
        class:on={focusId === app.id}
        style="--c: {app.color}"
        onmouseenter={() => (selected = app.id)}
        onfocus={() => (selected = app.id)}
        onclick={(e) => {
          e.preventDefault();
          launch(app.id);
        }}
      >
        <span class="n">{pad(i + 1)}</span>
        <span class="dot s-{statuses[app.id]}"></span>
        <span class="name">{app.name}</span>
      </a>
    {/each}
  </nav>

  {#if toast}<div class="toast" role="status">{toast}</div>{/if}
  <div class="flash" class:on={flash} style="--c: {focus?.color ?? '#fff'}"></div>
  {#if !coarse}
    <div class="cursor" class:hot={!!hovered} bind:this={cursor} style="--c: {APPS.find((a) => a.id === hovered)?.color ?? '#fff'}"></div>
  {/if}
</main>
