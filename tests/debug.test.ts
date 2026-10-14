import { describe, expect, it } from 'vitest';
import { debugModeEnabled, effectiveDebugDate, selfTestModeEnabled } from '../src/debug';

describe('debug query behavior', () => {
  it('enables debug time for both legacy debug=1 and the full debug=0 panel', () => {
    expect(debugModeEnabled('?debug=1')).toBe(true);
    expect(debugModeEnabled('?debug=0')).toBe(true);
    expect(debugModeEnabled('?debug')).toBe(false);
    expect(debugModeEnabled('')).toBe(false);
  });

  it('applies a simulated time in either debug mode', () => {
    const debugNow = new Date('2026-08-10T02:30:00.000Z');
    const liveNow = new Date('2026-10-04T12:00:00.000Z');
    expect(effectiveDebugDate('?debug=1', debugNow, liveNow)).toEqual(debugNow);
    expect(effectiveDebugDate('?debug=0', debugNow, liveNow)).toEqual(debugNow);
  });

  it('enables the safe self-test panel only for debug=0', () => {
    expect(selfTestModeEnabled('?debug=0')).toBe(true);
    expect(selfTestModeEnabled('?debug=1')).toBe(false);
  });
});
