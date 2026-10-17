import { describe, expect, it } from 'vitest';
import { statusesFrom, type AppSpec, type StatusReport } from './apps';

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
