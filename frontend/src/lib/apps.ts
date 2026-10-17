import registry from '../../../apps.json';

export type Status = 'up' | 'down' | 'unknown';

export interface AppSpec {
  id: string;
  name: string;
  blurb: string;
  url: string;
  color: string;
  kind: 'app' | 'service';
  style: string;
  host: 'pi' | 'github';
}

export interface HostReadings {
  temp_c: number | null;
  uptime_s: number | null;
  mem_used_pct: number | null;
  load1: number | null;
}

export interface StatusReport {
  checked_at: number;
  host: HostReadings;
  apps: Record<string, { up: boolean; ms: number | null }>;
}

export const APPS = registry as AppSpec[];

/** Every network call gives up after this, so a Pi out of reach never hangs the page. */
export const NETWORK_TIMEOUT_MS = 4000;

/**
 * What each planet should show. With no fresh report from the Pi every app it would have
 * vouched for is unknown: a stale "up" from the last check is never shown as current.
 * Apps off the Pi can still be vouched for by the browser asking them directly.
 */
export function statusesFrom(
  report: StatusReport | null,
  specs: AppSpec[],
  directlyReachable: Set<string> = new Set()
): Record<string, Status> {
  const out: Record<string, Status> = {};
  for (const spec of specs) {
    const probe = report?.apps[spec.id];
    if (probe) out[spec.id] = probe.up ? 'up' : 'down';
    else out[spec.id] = directlyReachable.has(spec.id) ? 'up' : 'unknown';
  }
  return out;
}

export async function fetchStatus(): Promise<StatusReport | null> {
  try {
    const res = await fetch('/api/status', { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS), cache: 'no-store' });
    // 502-504 is Caddy answering for a stopped app: the Pi is there but we are not.
    if (!res.ok) return null;
    return (await res.json()) as StatusReport;
  } catch {
    return null;
  }
}

/** With the Pi out of reach, ask the apps hosted elsewhere ourselves. */
export async function probeDirect(specs: AppSpec[]): Promise<Set<string>> {
  const away = specs.filter((s) => s.host !== 'pi');
  const results = await Promise.all(
    away.map(async (s) => {
      try {
        await fetch(s.url, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
        return s.id;
      } catch {
        return null;
      }
    })
  );
  return new Set(results.filter((id): id is string => id !== null));
}

/**
 * Where to send the browser to open an app.
 *
 * Installed on Android, Orrery runs in its own standalone window, and Chrome keeps any
 * link outside Orrery's scope in a Custom Tab instead of opening the installed app. An
 * intent:// VIEW goes to Android instead, which hands the URL to whatever registered it:
 * the app's installed PWA if there is one, else the browser. NEW_TASK (0x10000000) stops
 * Orrery's window swallowing it. The fallback covers a browser that won't take intents.
 *
 * iOS has no equivalent: a home screen web app can't open another one, so it gets the
 * plain URL like everything else.
 */
export function launchUrl(url: string, env: { android: boolean; standalone: boolean }): string {
  if (!env.android || !env.standalone || !/^https?:\/\//.test(url)) return url;
  const { protocol, host, pathname, search, hash } = new URL(url);
  const fallback = encodeURIComponent(url);
  return (
    `intent://${host}${pathname}${search}${hash}#Intent;scheme=${protocol.slice(0, -1)};` +
    `action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;` +
    `launchFlags=0x10000000;S.browser_fallback_url=${fallback};end`
  );
}

export function launchEnv() {
  return {
    android: /Android/i.test(navigator.userAgent),
    standalone: window.matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches
  };
}
