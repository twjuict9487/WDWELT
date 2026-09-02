import { describe, expect, it } from 'vitest';
import { EMPTY_STATE, STORAGE_KEY, loadStateResult, persistState, replaceTimetable, updateProgress, type StorageLike } from '../src/storage';

class ControlledStorage implements StorageLike {
  values = new Map<string, string>();
  failRead = false;
  failWrite = false;
  getItem(key: string): string | null { if (this.failRead) throw new Error('blocked'); return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { if (this.failWrite) throw new Error('quota'); this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

describe('G2 Storage v2 compatibility and failure safety', () => {
  it('loads existing v2 data and continues updating without schema migration', () => {
    const storage = new ControlledStorage();
    const scheduled = replaceTimetable(structuredClone(EMPTY_STATE), [{ weekday: 1, period: 1, className: '307' }]);
    const courseId = scheduled.courses[0].courseId;
    const original = updateProgress(scheduled, courseId, 'P.52', '保留備註', new Date('2026-09-01T00:00:00Z'));
    persistState(original, storage);
    const loaded = loadStateResult(storage);
    expect(loaded.error).toBeNull();
    expect(loaded.state).toEqual(original);
    const updated = updateProgress(loaded.state, courseId, 'P.53', '新備註', new Date('2026-09-02T00:00:00Z'));
    persistState(updated, storage);
    expect(loadStateResult(storage).state.progressByCourse[courseId].progress).toBe('P.53');
  });

  it('preserves malformed raw data rather than overwriting it with empty state', () => {
    const storage = new ControlledStorage();
    storage.values.set(STORAGE_KEY, '{broken-json');
    const result = loadStateResult(storage);
    expect(result.error).toContain('原始資料已保留');
    expect(result.state).toEqual(EMPTY_STATE);
    expect(storage.values.get(STORAGE_KEY)).toBe('{broken-json');
  });

  it('rejects structurally invalid v2 schedule data without rewriting it', () => {
    const storage = new ControlledStorage();
    const raw = JSON.stringify({ version: 2, courses: [], timetable: { timezone: 'Asia/Taipei', entries: [{ weekday: 9, period: 1, courseId: 'missing' }], updatedAt: 'bad' }, progressByCourse: {} });
    storage.values.set(STORAGE_KEY, raw);
    const result = loadStateResult(storage);
    expect(result.error).toContain('原始資料已保留');
    expect(storage.values.get(STORAGE_KEY)).toBe(raw);
  });

  it('reports localStorage read and write failures without a false success path', () => {
    const storage = new ControlledStorage();
    storage.failRead = true;
    expect(loadStateResult(storage).error).toContain('無法讀取');
    storage.failRead = false; storage.failWrite = true;
    expect(() => persistState(structuredClone(EMPTY_STATE), storage)).toThrow('quota');
  });
});
