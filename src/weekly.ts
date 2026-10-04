import type { AppState } from './types';
import { getTaipeiParts, type TimelineRole, type TimelineScheduleState } from './schedule';
import type { TimetableEntry } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

export function weeklyEntryTimelineRole(
  entry: TimetableEntry,
  timeline: TimelineScheduleState,
  now: Date,
): TimelineRole | null {
  const today = getTaipeiParts(now);
  const weekStart = Date.UTC(today.year, today.month - 1, today.day) - (today.weekday - 1) * DAY_MS;
  const weekEnd = weekStart + 5 * DAY_MS;
  for (const role of ['current', 'last', 'next'] as const) {
    const item = timeline[role];
    if (!item) continue;
    const itemDate = Date.UTC(item.date.year, item.date.month - 1, item.date.day);
    if (itemDate < weekStart || itemDate >= weekEnd) continue;
    if (item.entry.courseId === entry.courseId
      && item.entry.weekday === entry.weekday
      && item.entry.period === entry.period) return role;
  }
  return null;
}

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
