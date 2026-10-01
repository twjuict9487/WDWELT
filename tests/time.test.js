import { describe, expect, it } from 'vitest';
import { formatTaipeiDateTime, toTaipeiIsoString } from '../db/core/time.mjs';

describe('Taipei timestamp convention', () => {
  it('renders instants with an explicit Taipei offset', () => {
    expect(toTaipeiIsoString(new Date('2026-10-01T23:00:00.123Z'))).toBe('2026-10-02T07:00:00.123+08:00');
    expect(formatTaipeiDateTime(new Date('2026-10-01T23:00:00.123Z'))).toBe('2026-10-02 07:00:00 +08:00');
  });

  it('treats an unqualified database DATETIME string as Taipei wall-clock time', () => {
    expect(toTaipeiIsoString('2026-10-02 07:00:00.123')).toBe('2026-10-02T07:00:00.123+08:00');
  });
});
