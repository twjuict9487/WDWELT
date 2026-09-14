import { describe, expect, it } from 'vitest';
import { weeklyCourses } from '../src/weekly';
import type { AppState } from '../src/types';

const fixture = (): AppState => ({ version: 2, courses: [{ courseId: '7', className: '307' }, { courseId: '8', className: '二年甲班' }],
  timetable: { timezone: 'Asia/Taipei', updatedAt: '', entries: [
    { weekday: 5, period: 8, courseId: '7' }, { weekday: 1, period: 4, courseId: '8' }, { weekday: 1, period: 1, courseId: '7' },
  ] }, progressByCourse: { '7': { courseId: '7', progress: 'P.61', note: '共用備註', updatedAt: '' } } });

describe('weekly course view of the existing account state', () => {
  it('retains every occurrence in Monday-Friday and period order without mutating timetable', () => {
    const state = fixture(); const before = structuredClone(state);
    const groups = weeklyCourses(state);
    expect(groups.map((day) => day.weekday)).toEqual([1, 2, 3, 4, 5]);
    expect(groups[0].entries.map((entry) => entry.period)).toEqual([1, 4]);
    expect(groups.flatMap((day) => day.entries)).toHaveLength(3);
    expect(groups[4].entries[0]).toMatchObject({ courseId: '7', progress: 'P.61' });
    expect(groups[0].entries[0]).toMatchObject({ courseId: '7', progress: 'P.61' });
    expect(groups[0].entries[1].progress).toBe('尚未紀錄');
    expect(state).toEqual(before);
  });
  it('reflects the existing save result for all occurrences and handles missing courses and empty days', () => {
    const state = fixture();
    state.progressByCourse['7'].progress = '最新進度';
    expect(weeklyCourses(state).flatMap((day) => day.entries).filter((entry) => entry.courseId === '7').every((entry) => entry.progress === '最新進度')).toBe(true);
    state.courses = [];
    expect(weeklyCourses(state)[0].entries[0].className).toBeNull();
    state.timetable = null;
    expect(weeklyCourses(state).every((day) => day.entries.length === 0)).toBe(true);
  });
});
