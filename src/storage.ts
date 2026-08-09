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

export function loadState(storage: StorageLike = localStorage): AppState {
  storage.removeItem(LEGACY_STORAGE_KEY);
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return structuredClone(EMPTY_STATE);

  try {
    const parsed = JSON.parse(raw) as Partial<AppState>;
    if (parsed.version !== 2) return structuredClone(EMPTY_STATE);
    const courses = Array.isArray(parsed.courses)
      ? parsed.courses.flatMap((course) => {
          const record = course as unknown as {
            courseId?: unknown;
            className?: unknown;
            destination?: unknown;
          };
          const className = typeof record.className === 'string'
            ? record.className
            : typeof record.destination === 'string'
              ? record.destination
              : '';
          if (typeof record.courseId !== 'string' || !normalizeClassName(className)) return [];
          return [{ courseId: record.courseId, className: normalizeClassName(className) }];
        })
      : [];
    return {
      version: 2,
      timetable: parsed.timetable ?? null,
      courses,
      progressByCourse: parsed.progressByCourse ?? {},
    };
  } catch {
    return structuredClone(EMPTY_STATE);
  }
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
