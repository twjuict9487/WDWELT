import { describe, expect, it } from 'vitest';
import {
  EMPTY_STATE,
  deleteTimetable,
  loadState,
  persistState,
  replaceTimetable,
  updateProgress,
  type StorageLike,
} from '../src/storage';
import type { AppState, DraftEntry } from '../src/types';

class MemoryStorage implements StorageLike {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const chemistry: DraftEntry = {
  weekday: 1,
  period: 3,
  start: '10:10',
  end: '11:00',
  subject: '化學',
  className: '高307',
};

function freshState(): AppState {
  return structuredClone(EMPTY_STATE);
}

describe('localStorage persistence', () => {
  it('save/load 後保留結構化課表', () => {
    const storage = new MemoryStorage();
    const state = replaceTimetable(freshState(), [chemistry], new Date('2026-08-08T00:00:00Z'));
    persistState(state, storage);
    const loaded = loadState(storage);
    expect(loaded).toEqual(state);
    expect(loaded.courses[0].className).toBe('307');
  });

  it('reload 後 progress、note、updatedAt 仍存在', () => {
    const storage = new MemoryStorage();
    const withTimetable = replaceTimetable(freshState(), [chemistry]);
    const courseId = withTimetable.courses[0].courseId;
    const saved = updateProgress(
      withTimetable,
      courseId,
      'Ch.3 P.56',
      'Example 3-2 unfinished',
      new Date('2026-08-07T03:02:00.000Z'),
    );
    persistState(saved, storage);
    expect(loadState(storage).progressByCourse[courseId]).toEqual({
      courseId,
      progress: 'Ch.3 P.56',
      note: 'Example 3-2 unfinished',
      updatedAt: '2026-08-07T03:02:00.000Z',
    });
  });

  it('replace timetable 後相同課程沿用 courseId 並保留進度', () => {
    const first = replaceTimetable(freshState(), [chemistry]);
    const courseId = first.courses[0].courseId;
    const withProgress = updateProgress(first, courseId, 'P.56', '', new Date('2026-08-07T03:02:00Z'));
    const replacement = replaceTimetable(withProgress, [{ ...chemistry, weekday: 2, subject: '  化學 ', className: ' 307 ' }]);
    expect(replacement.timetable?.entries[0].courseId).toBe(courseId);
    expect(replacement.progressByCourse[courseId].progress).toBe('P.56');
  });

  it('delete timetable 不刪除 course catalog 或進度', () => {
    const first = replaceTimetable(freshState(), [chemistry]);
    const courseId = first.courses[0].courseId;
    const withProgress = updateProgress(first, courseId, 'P.56', '待補充');
    const deleted = deleteTimetable(withProgress);
    expect(deleted.timetable).toBeNull();
    expect(deleted.courses).toEqual(first.courses);
    expect(deleted.progressByCourse[courseId].note).toBe('待補充');
  });

  it('儲存進度時自動使用注入 timestamp', () => {
    const now = new Date('2026-08-08T01:23:45.000Z');
    const updated = updateProgress(freshState(), 'course_test', 'P.1', '', now);
    expect(updated.progressByCourse.course_test.updatedAt).toBe(now.toISOString());
  });
});
