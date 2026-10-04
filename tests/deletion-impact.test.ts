import { describe, expect, it } from 'vitest';
import { timetableDeletionImpact } from '../src/deletion-impact';
import type { AppState } from '../src/types';

describe('timetable deletion impact', () => {
  it('matches deletion of all entries, resulting unused courses, and their progress', () => {
    const state: AppState = {
      version: 2,
      timetable: { timezone: 'Asia/Taipei', updatedAt: '', entries: [
        { weekday: 1, period: 1, courseId: '1' },
        { weekday: 2, period: 2, courseId: '1' },
        { weekday: 3, period: 3, courseId: '2' },
      ] },
      courses: [{ courseId: '1', className: '一班' }, { courseId: '2', className: '二班' }],
      progressByCourse: { '1': { courseId: '1', progress: 'P.1', note: '', updatedAt: '' } },
    };
    expect(timetableDeletionImpact(state)).toEqual({ timetableEntries: 3, unusedCourses: 2, progressRecords: 1 });
  });
});
