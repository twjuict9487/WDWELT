import { TIMEZONE, type Timetable, type TimetableEntry } from './types';

export interface PeriodDefinition {
  period: number;
  start: string;
  end: string;
}

export const PERIODS: readonly PeriodDefinition[] = [
  { period: 1, start: '08:10', end: '09:00' },
  { period: 2, start: '09:10', end: '10:00' },
  { period: 3, start: '10:10', end: '11:00' },
  { period: 4, start: '11:10', end: '12:00' },
  { period: 5, start: '13:05', end: '13:55' },
  { period: 6, start: '14:05', end: '14:55' },
  { period: 7, start: '15:10', end: '16:00' },
  { period: 8, start: '16:10', end: '17:00' },
] as const;

export interface TaipeiDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

export interface ScheduledClass {
  entry: TimetableEntry;
  start: string;
  end: string;
  startAt: Date;
  endAt: Date;
  date: { year: number; month: number; day: number; weekday: number };
}

export type HomeMode = 'current' | 'gap' | 'after-school' | 'next-only';
export type HomeTab = 'current' | 'next' | 'previous';

export interface HomeScheduleState {
  mode: HomeMode;
  defaultTab: HomeTab;
  current: ScheduledClass | null;
  next: ScheduledClass | null;
  previousToday: ScheduledClass | null;
}

export type TimelineRole = 'last' | 'current' | 'next';

export interface TimelineScheduleState {
  last: ScheduledClass | null;
  current: ScheduledClass | null;
  next: ScheduledClass | null;
  defaultRole: TimelineRole | null;
  signature: string;
}

const partsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function getTaipeiParts(date: Date): TaipeiDateParts {
  const parts = Object.fromEntries(
    partsFormatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const utcCalendar = new Date(Date.UTC(year, month - 1, day));
  const sundayBased = utcCalendar.getUTCDay();
  return {
    year,
    month,
    day,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: sundayBased === 0 ? 7 : sundayBased,
  };
}

function addCalendarDays(parts: TaipeiDateParts, days: number): TaipeiDateParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  const sundayBased = date.getUTCDay();
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
    weekday: sundayBased === 0 ? 7 : sundayBased,
  };
}

function parseClock(clock: string): { hour: number; minute: number } {
  const match = /^(\d{2}):(\d{2})$/.exec(clock);
  if (!match) throw new Error(`無效時間：${clock}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`無效時間：${clock}`);
  return { hour, minute };
}

export function taipeiDateToInstant(
  date: { year: number; month: number; day: number },
  clock: string,
): Date {
  const { hour, minute } = parseClock(clock);
  return new Date(Date.UTC(date.year, date.month - 1, date.day, hour - 8, minute));
}

export function getPeriodDefinition(period: number): PeriodDefinition | undefined {
  return PERIODS.find((definition) => definition.period === period);
}

function scheduledClassForDate(
  entry: TimetableEntry,
  date: { year: number; month: number; day: number; weekday: number },
): ScheduledClass | null {
  const period = getPeriodDefinition(entry.period);
  if (!period) return null;
  return {
    entry,
    start: period.start,
    end: period.end,
    startAt: taipeiDateToInstant(date, period.start),
    endAt: taipeiDateToInstant(date, period.end),
    date,
  };
}

function classesOnDate(
  timetable: Timetable,
  date: { year: number; month: number; day: number; weekday: number },
): ScheduledClass[] {
  return timetable.entries
    .filter((entry) => entry.weekday === date.weekday)
    .map((entry) => scheduledClassForDate(entry, date))
    .filter((item): item is ScheduledClass => item !== null)
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
}

function findNextClass(timetable: Timetable, now: Date, today: TaipeiDateParts): ScheduledClass | null {
  for (let offset = 0; offset <= 7; offset += 1) {
    const date = addCalendarDays(today, offset);
    const dateOnly = { year: date.year, month: date.month, day: date.day, weekday: date.weekday };
    const next = classesOnDate(timetable, dateOnly).find((item) => item.startAt.getTime() > now.getTime());
    if (next) return next;
  }
  return null;
}

function findLastClass(timetable: Timetable, now: Date, today: TaipeiDateParts): ScheduledClass | null {
  for (let offset = 0; offset >= -7; offset -= 1) {
    const date = addCalendarDays(today, offset);
    const dateOnly = { year: date.year, month: date.month, day: date.day, weekday: date.weekday };
    const ended = classesOnDate(timetable, dateOnly)
      .filter((item) => item.endAt.getTime() <= now.getTime());
    const last = ended.at(-1);
    if (last) return last;
  }
  return null;
}

function occurrenceIdentity(role: TimelineRole, item: ScheduledClass | null): string {
  if (!item) return '';
  const date = `${item.date.year}-${String(item.date.month).padStart(2, '0')}-${String(item.date.day).padStart(2, '0')}`;
  return `${role}:${item.entry.courseId}:${date}:${item.start}:${item.end}`;
}

export function selectDefaultTimelineRole(
  last: ScheduledClass | null,
  current: ScheduledClass | null,
  next: ScheduledClass | null,
): TimelineRole | null {
  if (current) return 'current';
  if (next) return 'next';
  if (last) return 'last';
  return null;
}

export function getTimelineScheduleState(
  timetable: Timetable | null,
  now: Date = new Date(),
): TimelineScheduleState {
  if (!timetable || timetable.entries.length === 0) {
    return { last: null, current: null, next: null, defaultRole: null, signature: '' };
  }

  const today = getTaipeiParts(now);
  const dateOnly = { year: today.year, month: today.month, day: today.day, weekday: today.weekday };
  const current = classesOnDate(timetable, dateOnly).find(
    (item) => item.startAt.getTime() <= now.getTime() && now.getTime() < item.endAt.getTime(),
  ) ?? null;
  const last = findLastClass(timetable, now, today);
  const next = findNextClass(timetable, now, today);
  const signature = [
    occurrenceIdentity('last', last),
    occurrenceIdentity('current', current),
    occurrenceIdentity('next', next),
  ].join('|');

  return {
    last,
    current,
    next,
    defaultRole: selectDefaultTimelineRole(last, current, next),
    signature,
  };
}

export function getHomeScheduleState(
  timetable: Timetable | null,
  now: Date = new Date(),
): HomeScheduleState {
  if (!timetable || timetable.entries.length === 0) {
    return { mode: 'next-only', defaultTab: 'next', current: null, next: null, previousToday: null };
  }

  const today = getTaipeiParts(now);
  const dateOnly = { year: today.year, month: today.month, day: today.day, weekday: today.weekday };
  const todayClasses = classesOnDate(timetable, dateOnly);
  const current = todayClasses.find(
    (item) => item.startAt.getTime() <= now.getTime() && now.getTime() < item.endAt.getTime(),
  ) ?? null;
  const ended = todayClasses.filter((item) => item.endAt.getTime() <= now.getTime());
  const previousToday = ended.at(-1) ?? null;
  const upcomingToday = todayClasses.find((item) => item.startAt.getTime() > now.getTime()) ?? null;
  const next = upcomingToday ?? findNextClass(timetable, now, today);

  if (current) {
    return { mode: 'current', defaultTab: 'current', current, next, previousToday };
  }
  if (previousToday && upcomingToday) {
    return { mode: 'gap', defaultTab: 'next', current: null, next, previousToday };
  }
  if (previousToday && !upcomingToday) {
    return { mode: 'after-school', defaultTab: 'previous', current: null, next, previousToday };
  }
  return { mode: 'next-only', defaultTab: 'next', current: null, next, previousToday: null };
}

export function createDebugInstant(date: string, time: string): Date {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!dateMatch) throw new Error('請選擇有效日期');
  return taipeiDateToInstant(
    { year: Number(dateMatch[1]), month: Number(dateMatch[2]), day: Number(dateMatch[3]) },
    time,
  );
}
