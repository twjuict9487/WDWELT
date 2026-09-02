import {
  TIMEZONE,
  type AppState,
  type Course,
  type CourseProgress,
  type DraftEntry,
} from './types';

export const STORAGE_KEY = 'today-progress-g1:v2';
export const LEGACY_STORAGE_KEY = 'today-progress-g1:v1';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const EMPTY_STATE: AppState = {
  version: 2,
  timetable: null,
  courses: [],
  progressByCourse: {},
};

export interface LoadStateResult {
  state: AppState;
  error: string | null;
}

export function loadStateResult(storage: StorageLike = localStorage): LoadStateResult {
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return { state: structuredClone(EMPTY_STATE), error: '無法讀取瀏覽器 localStorage；原資料未被修改。' };
  }
  if (!raw) {
    try { storage.removeItem(LEGACY_STORAGE_KEY); } catch {
      return { state: structuredClone(EMPTY_STATE), error: '無法存取瀏覽器 localStorage；請檢查瀏覽器儲存權限。' };
    }
    return { state: structuredClone(EMPTY_STATE), error: null };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<AppState>;
    if (parsed.version !== 2 || !Array.isArray(parsed.courses)
      || typeof parsed.progressByCourse !== 'object' || parsed.progressByCourse === null) {
      throw new Error('invalid storage v2 shape');
    }
    const courses = parsed.courses.map((course) => {
      const record = course as unknown as { courseId?: unknown; className?: unknown; destination?: unknown };
      const className = typeof record.className === 'string' ? record.className : typeof record.destination === 'string' ? record.destination : '';
      if (typeof record.courseId !== 'string' || !record.courseId || !normalizeClassName(className)) throw new Error('invalid course');
      return { courseId: record.courseId, className: normalizeClassName(className) };
    });
    const courseIds = new Set(courses.map((course) => course.courseId));
    if (courseIds.size !== courses.length) throw new Error('duplicate courseId');

    let timetable = null;
    if (parsed.timetable != null) {
      const record = parsed.timetable as unknown as { timezone?: unknown; entries?: unknown; updatedAt?: unknown };
      if (record.timezone !== TIMEZONE || !Array.isArray(record.entries) || typeof record.updatedAt !== 'string') throw new Error('invalid timetable');
      const entries = record.entries.map((entry) => {
        const value = entry as { weekday?: unknown; period?: unknown; courseId?: unknown };
        if (!Number.isInteger(value.weekday) || Number(value.weekday) < 1 || Number(value.weekday) > 5
          || !Number.isInteger(value.period) || Number(value.period) < 1 || Number(value.period) > 8
          || typeof value.courseId !== 'string' || !courseIds.has(value.courseId)) throw new Error('invalid timetable entry');
        return { weekday: Number(value.weekday), period: Number(value.period), courseId: value.courseId };
      });
      timetable = { timezone: TIMEZONE, entries, updatedAt: record.updatedAt };
    }

    const progressByCourse: Record<string, CourseProgress> = {};
    for (const [courseId, progress] of Object.entries(parsed.progressByCourse)) {
      const value = progress as unknown as { courseId?: unknown; progress?: unknown; note?: unknown; updatedAt?: unknown };
      if (value.courseId !== courseId || typeof value.progress !== 'string' || typeof value.note !== 'string' || typeof value.updatedAt !== 'string') throw new Error('invalid progress');
      progressByCourse[courseId] = { courseId, progress: value.progress, note: value.note, updatedAt: value.updatedAt };
    }
    try { storage.removeItem(LEGACY_STORAGE_KEY); } catch { /* v2 data remains readable */ }
    return {
      state: { version: 2, timetable, courses, progressByCourse },
      error: null,
    };
  } catch {
    return { state: structuredClone(EMPTY_STATE), error: 'Storage v2 資料無法解析；原始資料已保留，且本頁不會以空資料覆蓋。' };
  }
}

export function loadState(storage: StorageLike = localStorage): AppState {
  return loadStateResult(storage).state;
}

export function persistState(state: AppState, storage: StorageLike = localStorage): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function normalizeClassName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function classKey(value: string): string {
  return normalizeClassName(value).toLocaleLowerCase('zh-Hant');
}

function hashKey(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function resolveCourse(courses: Course[], className: string): Course {
  const normalized = normalizeClassName(className);
  const key = classKey(normalized);
  const existing = courses.find((course) => classKey(course.className) === key);
  if (existing) return existing;

  let courseId = `course_${hashKey(key)}`;
  let suffix = 2;
  while (courses.some((course) => course.courseId === courseId)) {
    courseId = `course_${hashKey(key)}_${suffix}`;
    suffix += 1;
  }
  const course = { courseId, className: normalized };
  courses.push(course);
  return course;
}

export function replaceTimetable(
  state: AppState,
  draftEntries: DraftEntry[],
  now: Date = new Date(),
): AppState {
  const courses = state.courses.map((course) => ({ ...course }));
  const entriesByPosition = new Map<string, DraftEntry>();

  for (const entry of draftEntries) {
    const className = normalizeClassName(entry.className);
    if (!className || entry.weekday < 1 || entry.weekday > 5 || entry.period < 1 || entry.period > 8) continue;
    entriesByPosition.set(`${entry.weekday}:${entry.period}`, { ...entry, className });
  }

  const entries = [...entriesByPosition.values()]
    .map((entry) => ({
      weekday: entry.weekday,
      period: entry.period,
      courseId: resolveCourse(courses, entry.className).courseId,
    }))
    .sort((a, b) => a.weekday - b.weekday || a.period - b.period);

  return {
    ...state,
    courses,
    timetable: { timezone: TIMEZONE, entries, updatedAt: now.toISOString() },
  };
}

export function deleteTimetable(state: AppState): AppState {
  return { ...state, timetable: null };
}

export function clearAllProgress(state: AppState): AppState {
  return { ...state, progressByCourse: {} };
}

export function updateProgress(
  state: AppState,
  courseId: string,
  progress: string,
  note: string,
  now: Date = new Date(),
): AppState {
  return {
    ...state,
    progressByCourse: {
      ...state.progressByCourse,
      [courseId]: {
        courseId,
        progress: progress.trim(),
        note: note.trim(),
        updatedAt: now.toISOString(),
      },
    },
  };
}

export function restoreProgress(
  state: AppState,
  courseId: string,
  previous: CourseProgress | undefined,
): AppState {
  const progressByCourse = { ...state.progressByCourse };
  if (previous) progressByCourse[courseId] = { ...previous };
  else delete progressByCourse[courseId];
  return { ...state, progressByCourse };
}
