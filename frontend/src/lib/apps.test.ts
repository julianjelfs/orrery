import { describe, expect, it } from 'vitest';
import { launchUrl, statusesFrom, type AppSpec, type StatusReport } from './apps';

const spec = (id: string, host: 'pi' | 'github'): AppSpec => ({
  id,
  name: id,
  blurb: '',
  url: `https://${id}.example`,
  color: '#fff',
  kind: 'app',
  style: 'moon',
  host
});
const SPECS = [spec('recipes', 'pi'), spec('hive', 'pi'), spec('askance', 'github')];

describe('statusesFrom', () => {
  it('invariant 6: with no fresh report from the Pi, no app is shown as up or down on its say-so', () => {
    const statuses = statusesFrom(null, SPECS);
    expect(Object.values(statuses)).toEqual(['unknown', 'unknown', 'unknown']);
  });

  it('invariant 6: an app off the Pi the browser reached itself is up even with the Pi away', () => {
    expect(statusesFrom(null, SPECS, new Set(['askance'])).askance).toBe('up');
  });

  it('follows the report when there is one', () => {
    const report: StatusReport = {
      checked_at: 0,
      host: { temp_c: null, uptime_s: null, mem_used_pct: null, load1: null },
      apps: { recipes: { up: true, ms: 3 }, hive: { up: false, ms: null } }
    };
    expect(statusesFrom(report, SPECS)).toEqual({ recipes: 'up', hive: 'down', askance: 'unknown' });
  });
});

describe('launchUrl', () => {
  const url = 'https://julianjelfs.github.io/askance-web/';

  it('invariant 7: installed on Android, an app opens through an Android VIEW intent, falling back to its URL', () => {
    const intent = launchUrl(url, { android: true, standalone: true });
    expect(intent.startsWith('intent://julianjelfs.github.io/askance-web/#Intent;scheme=https;')).toBe(true);
    expect(intent).toContain('action=android.intent.action.VIEW');
    expect(intent).toContain(`S.browser_fallback_url=${encodeURIComponent(url)};end`);
  });

  it('invariant 7: in a browser tab, or anywhere but Android, an app opens at its plain URL', () => {
    expect(launchUrl(url, { android: true, standalone: false })).toBe(url);
    expect(launchUrl(url, { android: false, standalone: true })).toBe(url);
  });
});
