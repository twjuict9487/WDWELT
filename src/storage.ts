import {
  TIMEZONE,
  type AppState,
  type Course,
  type DraftEntry,
} from './types';

export const STORAGE_KEY = 'today-progress-g1:v1';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const EMPTY_STATE: AppState = {
  version: 1,
  timetable: null,
  courses: [],
  progressByCourse: {},
};

export function loadState(storage: StorageLike = localStorage): AppState {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return structuredClone(EMPTY_STATE);

  try {
    const parsed = JSON.parse(raw) as Partial<AppState>;
    if (parsed.version !== 1) return structuredClone(EMPTY_STATE);
    return {
      version: 1,
      timetable: parsed.timetable ?? null,
      courses: Array.isArray(parsed.courses) ? parsed.courses : [],
      progressByCourse: parsed.progressByCourse ?? {},
    };
  } catch {
    return structuredClone(EMPTY_STATE);
  }
}

export function persistState(state: AppState, storage: StorageLike = localStorage): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function normalizeCoursePart(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function normalizeClassName(value: string): string {
  const normalized = normalizeCoursePart(value);
  return normalized.replace(/^高(?=\d)/, '');
}

function courseKey(subject: string, className: string): string {
  return `${normalizeCoursePart(subject).toLocaleLowerCase('zh-Hant')}\u0000${normalizeClassName(className).toLocaleLowerCase('zh-Hant')}`;
}

function hashKey(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function resolveCourse(courses: Course[], subject: string, className: string): Course {
  const cleanSubject = normalizeCoursePart(subject);
  const cleanClassName = normalizeClassName(className);
  const key = courseKey(cleanSubject, cleanClassName);
  const existing = courses.find((course) => courseKey(course.subject, course.className) === key);
  if (existing) return existing;

  let courseId = `course_${hashKey(key)}`;
  let suffix = 2;
  while (courses.some((course) => course.courseId === courseId)) {
    courseId = `course_${hashKey(key)}_${suffix}`;
    suffix += 1;
  }
  const course = { courseId, subject: cleanSubject, className: cleanClassName };
  courses.push(course);
  return course;
}

export function replaceTimetable(
  state: AppState,
  draftEntries: DraftEntry[],
  now: Date = new Date(),
): AppState {
  const courses = state.courses.map((course) => ({ ...course }));
  const entries = draftEntries
    .filter((entry) => normalizeCoursePart(entry.subject) && normalizeClassName(entry.className))
    .map((entry) => {
      const course = resolveCourse(courses, entry.subject, entry.className);
      return {
        weekday: entry.weekday,
        period: entry.period,
        start: entry.start,
        end: entry.end,
        courseId: course.courseId,
      };
    })
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
