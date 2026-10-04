import { describe, expect, it } from 'vitest';
import { nextTimetableInputIndex } from '../src/timetable-navigation';

describe('timetable keyboard navigation', () => {
  it('moves Enter down the same weekday and Shift+Enter upward without wrapping', () => {
    expect(nextTimetableInputIndex(0, 40)).toBe(5);
    expect(nextTimetableInputIndex(34, 40)).toBe(39);
    expect(nextTimetableInputIndex(35, 40)).toBeNull();
    expect(nextTimetableInputIndex(5, 40, true)).toBe(0);
    expect(nextTimetableInputIndex(4, 40, true)).toBeNull();
  });
});
