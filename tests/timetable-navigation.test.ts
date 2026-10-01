import { describe, expect, it } from 'vitest';
import { nextTimetableInputIndex } from '../src/timetable-navigation';

describe('timetable keyboard navigation', () => {
  it('moves Enter forward and Shift+Enter backward without wrapping', () => {
    expect(nextTimetableInputIndex(0, 40)).toBe(1);
    expect(nextTimetableInputIndex(38, 40)).toBe(39);
    expect(nextTimetableInputIndex(39, 40)).toBeNull();
    expect(nextTimetableInputIndex(1, 40, true)).toBe(0);
    expect(nextTimetableInputIndex(0, 40, true)).toBeNull();
  });
});
