import { describe, expect, it } from 'vitest';
import { createDebugInstant, getScheduleStatus, taipeiDateToInstant } from '../src/schedule';
import { TIMEZONE, type Timetable, type TimetableEntry } from '../src/types';

function entry(
  weekday: number,
  period: number,
  start: string,
  end: string,
  courseId = `course_${weekday}_${period}`,
): TimetableEntry {
  return { weekday, period, start, end, courseId };
}

function timetable(entries: TimetableEntry[]): Timetable {
  return { timezone: TIMEZONE, entries, updatedAt: '2026-08-01T00:00:00.000Z' };
}

const atTaipei = (date: string, time: string) => createDebugInstant(date, time);

describe('getScheduleStatus', () => {
  it('第一堂課前回傳下一堂課', () => {
    const result = getScheduleStatus(
      timetable([entry(1, 1, '08:10', '09:00')]),
      atTaipei('2026-08-10', '07:30'),
    );
    expect(result.kind).toBe('next');
    if (result.kind === 'next') expect(result.scheduledClass.entry.period).toBe(1);
  });

  it('start <= now < end 時回傳目前課程', () => {
    const schedule = timetable([entry(1, 1, '08:10', '09:00')]);
    expect(getScheduleStatus(schedule, atTaipei('2026-08-10', '08:10')).kind).toBe('current');
    expect(getScheduleStatus(schedule, atTaipei('2026-08-10', '08:59')).kind).toBe('current');
  });

  it('兩堂之間跳到下一個非空課程', () => {
    const result = getScheduleStatus(
      timetable([
        entry(1, 1, '08:10', '09:00'),
        entry(1, 3, '10:10', '11:00'),
      ]),
      atTaipei('2026-08-10', '09:30'),
    );
    expect(result.kind).toBe('next');
    if (result.kind === 'next') expect(result.scheduledClass.entry.period).toBe(3);
  });

  it('今天最後一堂結束後尋找下一個有課日', () => {
    const result = getScheduleStatus(
      timetable([
        entry(1, 1, '08:10', '09:00'),
        entry(2, 2, '09:10', '10:00'),
      ]),
      atTaipei('2026-08-10', '12:00'),
    );
    expect(result.kind).toBe('next');
    if (result.kind === 'next') {
      expect(result.scheduledClass.entry.weekday).toBe(2);
      expect(result.scheduledClass.date.day).toBe(11);
    }
  });

  it('星期五放學後找到下星期一', () => {
    const result = getScheduleStatus(
      timetable([entry(1, 1, '08:10', '09:00')]),
      atTaipei('2026-08-14', '17:00'),
    );
    expect(result.kind).toBe('next');
    if (result.kind === 'next') {
      expect(result.scheduledClass.date).toEqual({ year: 2026, month: 8, day: 17, weekday: 1 });
    }
  });

  it('空堂不會產生課程，直接跳到下一筆 entry', () => {
    const result = getScheduleStatus(
      timetable([entry(1, 4, '11:10', '12:00')]),
      atTaipei('2026-08-10', '08:30'),
    );
    expect(result.kind).toBe('next');
    if (result.kind === 'next') expect(result.scheduledClass.entry.period).toBe(4);
  });

  it('七天內無任何 entry 時回傳 none', () => {
    expect(getScheduleStatus(timetable([]), atTaipei('2026-08-10', '08:30'))).toEqual({ kind: 'none' });
  });

  it('跨日結果帶有實際日期', () => {
    const result = getScheduleStatus(
      timetable([entry(3, 1, '08:10', '09:00')]),
      atTaipei('2026-08-10', '20:00'),
    );
    expect(result.kind).toBe('next');
    if (result.kind === 'next') {
      expect(result.scheduledClass.date).toEqual({ year: 2026, month: 8, day: 12, weekday: 3 });
    }
  });

  it('接受注入的 debug time 且不依賴主機時區', () => {
    const debugNow = createDebugInstant('2026-08-10', '10:30');
    const result = getScheduleStatus(
      timetable([entry(1, 3, '10:10', '11:00')]),
      debugNow,
    );
    expect(debugNow.toISOString()).toBe('2026-08-10T02:30:00.000Z');
    expect(result.kind).toBe('current');
  });
});

describe('taipeiDateToInstant', () => {
  it('以明確 UTC+8 算術建立 instant，不使用含糊字串解析', () => {
    expect(taipeiDateToInstant({ year: 2026, month: 8, day: 10 }, '08:10').toISOString())
      .toBe('2026-08-10T00:10:00.000Z');
  });
});
