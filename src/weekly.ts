import type { AppState } from './types';

export function weeklyCourses(state: AppState) {
  const courses = new Map(state.courses.map((course) => [course.courseId, course]));
  return [1, 2, 3, 4, 5].map((weekday) => ({
    weekday,
    entries: (state.timetable?.entries ?? [])
      .filter((entry) => entry.weekday === weekday)
      .sort((a, b) => a.period - b.period)
      .map((entry) => ({
        ...entry,
        className: courses.get(entry.courseId)?.className ?? null,
        progress: state.progressByCourse[entry.courseId]?.progress || '尚未紀錄',
      })),
  }));
}
