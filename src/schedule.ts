import { TIMEZONE, type Timetable, type TimetableEntry } from './types';

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
  startAt: Date;
  endAt: Date;
  date: { year: number; month: number; day: number; weekday: number };
}

export type ScheduleResult =
  | { kind: 'current'; scheduledClass: ScheduledClass }
  | { kind: 'next'; scheduledClass: ScheduledClass }
  | { kind: 'none' };

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

export function getScheduleStatus(
  timetable: Timetable | null,
  now: Date = new Date(),
): ScheduleResult {
  if (!timetable || timetable.entries.length === 0) return { kind: 'none' };
  const today = getTaipeiParts(now);
  let nearest: ScheduledClass | null = null;

  for (let offset = 0; offset <= 7; offset += 1) {
    const date = addCalendarDays(today, offset);
    const entries = timetable.entries
      .filter((entry) => entry.weekday === date.weekday)
      .sort((a, b) => a.start.localeCompare(b.start));

    for (const entry of entries) {
      const startAt = taipeiDateToInstant(date, entry.start);
      const endAt = taipeiDateToInstant(date, entry.end);
      const scheduledClass = {
        entry,
        startAt,
        endAt,
        date: { year: date.year, month: date.month, day: date.day, weekday: date.weekday },
      };
      if (startAt.getTime() <= now.getTime() && now.getTime() < endAt.getTime()) {
        return { kind: 'current', scheduledClass };
      }
      if (startAt.getTime() > now.getTime() && (!nearest || startAt < nearest.startAt)) {
        nearest = scheduledClass;
      }
    }
    if (nearest) return { kind: 'next', scheduledClass: nearest };
  }

  return { kind: 'none' };
}

export function createDebugInstant(date: string, time: string): Date {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!dateMatch) throw new Error('請選擇有效日期');
  return taipeiDateToInstant(
    { year: Number(dateMatch[1]), month: Number(dateMatch[2]), day: Number(dateMatch[3]) },
    time,
  );
}
