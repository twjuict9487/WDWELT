import { describe, expect, it } from 'vitest';
import {
  EMPTY_STATE,
  LEGACY_STORAGE_KEY,
  STORAGE_KEY,
  clearAllProgress,
  deleteTimetable,
  loadState,
  persistState,
  replaceTimetable,
  restoreProgress,
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

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const class307: DraftEntry = { weekday: 1, period: 3, className: '307' };

function freshState(): AppState {
  return structuredClone(EMPTY_STATE);
}

describe('storage v2', () => {
  it('使用 v2 key save/load 課表', () => {
    const storage = new MemoryStorage();
    const saved = replaceTimetable(freshState(), [class307], new Date('2026-08-08T00:00:00Z'));
    persistState(saved, storage);
    expect(storage.getItem(STORAGE_KEY)).not.toBeNull();
    expect(loadState(storage)).toEqual(saved);
  });

  it('初始化移除 v1 且不 migration', () => {
    const storage = new MemoryStorage();
    storage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ version: 1, timetable: { legacy: true } }));
    const loaded = loadState(storage);
    expect(storage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
    expect(loaded).toEqual(EMPTY_STATE);
  });

  it('reload 後課表、進度、備註與 updatedAt 仍存在', () => {
    const storage = new MemoryStorage();
    const withTimetable = replaceTimetable(freshState(), [class307]);
    const courseId = withTimetable.courses[0].courseId;
    const saved = updateProgress(
      withTimetable,
      courseId,
      'P.56',
      '酸鹼滴定例題 4',
      new Date('2026-08-07T03:02:00.000Z'),
    );
    persistState(saved, storage);
    const loaded = loadState(storage);
    expect(loaded.timetable).toEqual(saved.timetable);
    expect(loaded.progressByCourse[courseId]).toEqual({
      courseId,
      progress: 'P.56',
      note: '酸鹼滴定例題 4',
      updatedAt: '2026-08-07T03:02:00.000Z',
    });
  });

  it('儲存進度時自動使用注入 timestamp', () => {
    const now = new Date('2026-08-08T01:23:45.000Z');
    const updated = updateProgress(freshState(), 'course_test', '第三章講完', '', now);
    expect(updated.progressByCourse.course_test.updatedAt).toBe(now.toISOString());
  });

  it('同一班級跨多格共用同一 courseId 與進度', () => {
    const replaced = replaceTimetable(freshState(), [
      class307,
      { weekday: 3, period: 6, className: '  307  ' },
    ]);
    expect(replaced.courses).toHaveLength(1);
    expect(new Set(replaced.timetable?.entries.map((entry) => entry.courseId)).size).toBe(1);
    const courseId = replaced.courses[0].courseId;
    const updated = updateProgress(replaced, courseId, 'Ch.3-2', '');
    expect(updated.progressByCourse[replaced.timetable?.entries[1].courseId ?? ''].progress).toBe('Ch.3-2');
  });

  it('replace timetable 後正規化相同班級沿用 courseId', () => {
    const first = replaceTimetable(freshState(), [{ ...class307, className: '三年  七班' }]);
    const courseId = first.courses[0].courseId;
    const replacement = replaceTimetable(first, [
      { weekday: 2, period: 4, className: '  三年 七班  ' },
    ]);
    expect(replacement.timetable?.entries[0].courseId).toBe(courseId);
  });

  it('replace timetable 不刪除不再出現班級的舊進度', () => {
    const first = replaceTimetable(freshState(), [class307]);
    const oldCourseId = first.courses[0].courseId;
    const withProgress = updateProgress(first, oldCourseId, 'P.56', '待補充');
    const replacement = replaceTimetable(withProgress, [
      { weekday: 2, period: 1, className: '205' },
    ]);
    expect(replacement.progressByCourse[oldCourseId].progress).toBe('P.56');
    expect(replacement.courses.some((course) => course.courseId === oldCourseId)).toBe(true);
    expect(replacement.courses).toHaveLength(2);
  });

  it('delete timetable 不刪除 classes 或 progress', () => {
    const first = replaceTimetable(freshState(), [class307]);
    const courseId = first.courses[0].courseId;
    const withProgress = updateProgress(first, courseId, '講義 P.17', '待訂正');
    const deleted = deleteTimetable(withProgress);
    expect(deleted.timetable).toBeNull();
    expect(deleted.courses).toEqual(first.courses);
    expect(deleted.progressByCourse[courseId].note).toBe('待訂正');
  });

  it('clear progress 不刪除 timetable 或 classes', () => {
    const first = replaceTimetable(freshState(), [class307]);
    const courseId = first.courses[0].courseId;
    const withProgress = updateProgress(first, courseId, 'P.56', '');
    const cleared = clearAllProgress(withProgress);
    expect(cleared.progressByCourse).toEqual({});
    expect(cleared.timetable).toEqual(first.timetable);
    expect(cleared.courses).toEqual(first.courses);
  });

  it('restore progress 精確還原 Save 前內容，或移除新建立的進度', () => {
    const first = replaceTimetable(freshState(), [class307]);
    const courseId = first.courses[0].courseId;
    const previous = updateProgress(first, courseId, 'P.17', '舊備註', new Date('2026-08-08T01:00:00Z'));
    const savedAgain = updateProgress(previous, courseId, 'P.18', '新備註', new Date('2026-08-08T02:00:00Z'));
    expect(restoreProgress(savedAgain, courseId, previous.progressByCourse[courseId])).toEqual(previous);
    expect(restoreProgress(updateProgress(first, courseId, 'P.1', ''), courseId, undefined).progressByCourse)
      .toEqual({});
  });
});
