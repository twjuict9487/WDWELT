import { describe, expect, it } from 'vitest';
import { debugModeEnabled, effectiveDebugDate } from '../src/debug';

describe('debug query behavior', () => {
  it('enables debug time only for an explicit debug=1 query', () => {
    expect(debugModeEnabled('?debug=1')).toBe(true);
    expect(debugModeEnabled('?debug=0')).toBe(false);
    expect(debugModeEnabled('?debug')).toBe(false);
    expect(debugModeEnabled('')).toBe(false);
  });

  it('ignores a stale debug time when debug=0', () => {
    const debugNow = new Date('2026-08-10T02:30:00.000Z');
    const liveNow = new Date('2026-10-04T12:00:00.000Z');
    expect(effectiveDebugDate('?debug=1', debugNow, liveNow)).toEqual(debugNow);
    expect(effectiveDebugDate('?debug=0', debugNow, liveNow)).toEqual(liveNow);
  });
});
