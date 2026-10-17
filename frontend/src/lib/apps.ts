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
  disk_pct?: number | null;
}

/** What systemd and /proc say about a Pi app. Any reading can be missing. */
export interface AppStats {
  state: string | null;
  cpu_pct: number | null;
  mem_mb: number | null;
  tasks: number | null;
  restarts: number | null;
  uptime_s: number | null;
  errors_24h: number | null;
  cert_days: number | null;
  backup: { ok: boolean; age_s: number | null } | null;
}

export interface AppProbe {
  up: boolean;
  ms: number | null;
  stats?: AppStats;
}

export interface StatusReport {
  checked_at: number;
  host: HostReadings;
  apps: Record<string, AppProbe>;
}

/** Backups run nightly; one missed night is a warning. */
export const BACKUP_STALE_S = 36 * 3600;
/** Caddy renews at 30 days left, so under 14 means renewal has been failing. */
export const CERT_WARN_DAYS = 14;

/**
 * The things worth flagging about a running app, in the words the HUD shows. An app with
 * none of these is healthy. Missing readings are not warnings: unknown is not bad.
 */
export function warningsFor(s: AppStats | undefined): string[] {
  if (!s) return [];
  const out: string[] = [];
  if (s.backup && !s.backup.ok) out.push('Last backup failed');
  else if (s.backup?.age_s != null && s.backup.age_s > BACKUP_STALE_S)
    out.push(`No backup for ${Math.round(s.backup.age_s / 3600)}h`);
  if (s.errors_24h) out.push(`${s.errors_24h} error${s.errors_24h === 1 ? '' : 's'} in 24h`);
  if (s.restarts) out.push(`Restarted ${s.restarts}×`);
  if (s.cert_days != null && s.cert_days < CERT_WARN_DAYS) out.push(`Certificate expires in ${s.cert_days}d`);
  return out;
}

export function formatDuration(s: number | null | undefined): string {
  if (s == null) return '--';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
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
