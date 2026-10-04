import type { AppState } from './types';
import { getPeriodDefinition, getTaipeiParts, taipeiDateToInstant, type TimelineRole, type TimelineScheduleState } from './schedule';
import type { TimetableEntry } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

export function weeklyEntryTimelineRole(
  entry: TimetableEntry,
  timeline: TimelineScheduleState,
  now: Date,
): TimelineRole | null {
  const today = getTaipeiParts(now);
  const todayDate = Date.UTC(today.year, today.month - 1, today.day);
  const weekStart = Date.UTC(today.year, today.month - 1, today.day) - (today.weekday - 1) * DAY_MS;
  const weekEnd = weekStart + 5 * DAY_MS;
  for (const role of ['current', 'last', 'next'] as const) {
    const item = timeline[role];
    if (!item) continue;
    const itemDate = Date.UTC(item.date.year, item.date.month - 1, item.date.day);
    if (itemDate < weekStart || itemDate >= weekEnd) continue;
    if (role !== 'current' && itemDate !== todayDate) continue;
    if (role === 'last' && !timeline.current) {
      const next = timeline.next;
      const nextDate = next ? Date.UTC(next.date.year, next.date.month - 1, next.date.day) : null;
      if (nextDate !== todayDate) continue;
    }
    if (item.entry.courseId === entry.courseId
      && item.entry.weekday === entry.weekday
      && item.entry.period === entry.period) return role;
  }
  return null;
}

export function weeklyEntryNeedsUpdate(
  entry: TimetableEntry,
  updatedAt: string | undefined,
  now: Date,
): boolean {
  const today = getTaipeiParts(now);
  const weekStart = new Date(Date.UTC(today.year, today.month - 1, today.day - (today.weekday - 1)));
  const occurrenceDate = new Date(weekStart.getTime() + (entry.weekday - 1) * DAY_MS);
  const period = getPeriodDefinition(entry.period);
  if (!period) return false;
  const date = {
    year: occurrenceDate.getUTCFullYear(),
    month: occurrenceDate.getUTCMonth() + 1,
    day: occurrenceDate.getUTCDate(),
  };
  const startAt = taipeiDateToInstant(date, period.start);
  const endAt = taipeiDateToInstant(date, period.end);
  if (endAt.getTime() > now.getTime()) return false;
  const savedAt = updatedAt ? new Date(updatedAt).getTime() : Number.NaN;
  return !Number.isFinite(savedAt) || savedAt < startAt.getTime();
}

export function weeklyCourses(state: AppState, now: Date = new Date()) {
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
        needsUpdate: weeklyEntryNeedsUpdate(entry, state.progressByCourse[entry.courseId]?.updatedAt, now),
      })),
  }));
}
