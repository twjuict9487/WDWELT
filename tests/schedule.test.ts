import { describe, expect, it } from 'vitest';
import {
  PERIODS,
  createDebugInstant,
  getHomeScheduleState,
  getTimelineScheduleState,
  selectDefaultTimelineRole,
  taipeiDateToInstant,
} from '../src/schedule';
import { TIMEZONE, type Timetable, type TimetableEntry } from '../src/types';

function entry(weekday: number, period: number, courseId = `course_${weekday}_${period}`): TimetableEntry {
  return { weekday, period, courseId };
}

function timetable(entries: TimetableEntry[]): Timetable {
  return { timezone: TIMEZONE, entries, updatedAt: '2026-08-01T00:00:00.000Z' };
}

const atTaipei = (date: string, time: string) => createDebugInstant(date, time);

describe('和平高中固定節次', () => {
  it('固定提供正確的第 1～8 節時間', () => {
    expect(PERIODS).toEqual([
      { period: 1, start: '08:10', end: '09:00' },
      { period: 2, start: '09:10', end: '10:00' },
      { period: 3, start: '10:10', end: '11:00' },
      { period: 4, start: '11:10', end: '12:00' },
      { period: 5, start: '13:05', end: '13:55' },
      { period: 6, start: '14:05', end: '14:55' },
      { period: 7, start: '15:10', end: '16:00' },
      { period: 8, start: '16:10', end: '17:00' },
    ]);
  });
});

describe('schedule engine', () => {
  it('第一堂以前只回傳下一堂', () => {
    const result = getHomeScheduleState(timetable([entry(1, 1)]), atTaipei('2026-08-10', '07:30'));
    expect(result.mode).toBe('next-only');
    expect(result.defaultTab).toBe('next');
    expect(result.previousToday).toBeNull();
    expect(result.next?.entry.period).toBe(1);
  });

  it('start <= now < end 為目前課程，結束邊界不再算目前課程', () => {
    const schedule = timetable([entry(1, 1), entry(1, 2)]);
    expect(getHomeScheduleState(schedule, atTaipei('2026-08-10', '08:10')).mode).toBe('current');
    expect(getHomeScheduleState(schedule, atTaipei('2026-08-10', '08:59')).mode).toBe('current');
    const atEnd = getHomeScheduleState(schedule, atTaipei('2026-08-10', '09:00'));
    expect(atEnd.current).toBeNull();
    expect(atEnd.mode).toBe('gap');
  });

  it('兩堂之間預設下一堂，並保留最近已結束課程', () => {
    const result = getHomeScheduleState(
      timetable([entry(1, 1, 'course_307'), entry(1, 2, 'course_205')]),
      atTaipei('2026-08-10', '09:05'),
    );
    expect(result.mode).toBe('gap');
    expect(result.defaultTab).toBe('next');
    expect(result.previousToday?.entry.courseId).toBe('course_307');
    expect(result.next?.entry.courseId).toBe('course_205');
  });

  it('午休／長空堂仍可更新上一堂並查看下一堂', () => {
    const result = getHomeScheduleState(
      timetable([entry(1, 4, 'course_203'), entry(1, 6, 'course_307')]),
      atTaipei('2026-08-10', '12:30'),
    );
    expect(result.mode).toBe('gap');
    expect(result.previousToday?.entry.period).toBe(4);
    expect(result.next?.entry.period).toBe(6);
  });

  it('空堂直接跳到下一個實際 entry', () => {
    const result = getHomeScheduleState(
      timetable([entry(1, 1), entry(1, 3)]),
      atTaipei('2026-08-10', '09:30'),
    );
    expect(result.next?.entry.period).toBe(3);
  });

  it('今天最後一堂結束後預設更新最後一堂', () => {
    const result = getHomeScheduleState(
      timetable([entry(1, 2, 'course_307'), entry(2, 1, 'course_205')]),
      atTaipei('2026-08-10', '10:00'),
    );
    expect(result.mode).toBe('after-school');
    expect(result.defaultTab).toBe('previous');
    expect(result.previousToday?.entry.courseId).toBe('course_307');
    expect(result.next?.entry.weekday).toBe(2);
  });

  it('第六節若是當日最後一堂，14:55 即進入放學後狀態', () => {
    const result = getHomeScheduleState(
      timetable([entry(1, 6, 'course_307'), entry(2, 1, 'course_205')]),
      atTaipei('2026-08-10', '14:55'),
    );
    expect(result.mode).toBe('after-school');
    expect(result.previousToday?.entry.period).toBe(6);
  });

  it('星期五放學後找到下星期一並帶有實際日期', () => {
    const result = getHomeScheduleState(
      timetable([entry(5, 6), entry(1, 1)]),
      atTaipei('2026-08-14', '17:00'),
    );
    expect(result.mode).toBe('after-school');
    expect(result.next?.date).toEqual({ year: 2026, month: 8, day: 17, weekday: 1 });
  });

  it('今天完全沒課時不提供上一堂，只找跨日下一堂', () => {
    const result = getHomeScheduleState(
      timetable([entry(3, 1)]),
      atTaipei('2026-08-10', '12:00'),
    );
    expect(result.mode).toBe('next-only');
    expect(result.previousToday).toBeNull();
    expect(result.next?.date).toEqual({ year: 2026, month: 8, day: 12, weekday: 3 });
  });

  it('七天內完全沒有 entry 時回傳沒有下一堂', () => {
    const result = getHomeScheduleState(timetable([]), atTaipei('2026-08-10', '08:30'));
    expect(result.next).toBeNull();
    expect(result.previousToday).toBeNull();
  });

  it('接受 injected debug time 且不依賴主機時區', () => {
    const debugNow = createDebugInstant('2026-08-10', '10:30');
    const result = getHomeScheduleState(timetable([entry(1, 3)]), debugNow);
    expect(debugNow.toISOString()).toBe('2026-08-10T02:30:00.000Z');
    expect(result.mode).toBe('current');
  });

  it('午夜後不會取昨天的上一堂', () => {
    const result = getHomeScheduleState(
      timetable([entry(1, 8, 'course_307')]),
      atTaipei('2026-08-11', '00:01'),
    );
    expect(result.previousToday).toBeNull();
    expect(result.mode).toBe('next-only');
  });
});

describe('首頁狀態', () => {
  it('課間預設下一堂 tab，更新 tab 指向今天上一堂', () => {
    const result = getHomeScheduleState(
      timetable([entry(1, 1, 'course_previous'), entry(1, 3, 'course_next')]),
      atTaipei('2026-08-10', '09:30'),
    );
    expect(result.defaultTab).toBe('next');
    expect(result.previousToday?.entry.courseId).toBe('course_previous');
  });

  it('放學後預設更新最後一堂', () => {
    const result = getHomeScheduleState(
      timetable([entry(1, 6, 'course_last')]),
      atTaipei('2026-08-10', '15:00'),
    );
    expect(result.defaultTab).toBe('previous');
    expect(result.previousToday?.entry.courseId).toBe('course_last');
  });

  it('第一堂前與今天沒課都不顯示上一堂', () => {
    const schedule = timetable([entry(1, 1)]);
    expect(getHomeScheduleState(schedule, atTaipei('2026-08-10', '07:00')).previousToday).toBeNull();
    expect(getHomeScheduleState(schedule, atTaipei('2026-08-11', '12:00')).previousToday).toBeNull();
  });
});

describe('首頁 Last / Current / Next timeline', () => {
  it('上課中依固定角色提供 Last、Current、Next，且 Current 不重複', () => {
    const result = getTimelineScheduleState(
      timetable([
        entry(1, 1, 'course_last'),
        entry(1, 3, 'course_current'),
        entry(1, 6, 'course_next'),
      ]),
      atTaipei('2026-08-10', '10:30'),
    );
    expect(result.last?.entry.courseId).toBe('course_last');
    expect(result.current?.entry.courseId).toBe('course_current');
    expect(result.next?.entry.courseId).toBe('course_next');
    expect(result.defaultRole).toBe('current');
  });

  it('課間與午休沒有假的 Current，並跨空堂選最近 occurrence', () => {
    const result = getTimelineScheduleState(
      timetable([entry(1, 1, 'course_last'), entry(1, 6, 'course_next')]),
      atTaipei('2026-08-10', '12:30'),
    );
    expect(result.current).toBeNull();
    expect(result.last?.entry.courseId).toBe('course_last');
    expect(result.next?.entry.courseId).toBe('course_next');
    expect(result.defaultRole).toBe('next');
  });

  it('星期一第一堂前的 Last 可跨週末回到上星期五，Next 是今天第一堂', () => {
    const result = getTimelineScheduleState(
      timetable([entry(5, 8, 'course_friday'), entry(1, 1, 'course_monday')]),
      atTaipei('2026-08-17', '07:30'),
    );
    expect(result.last?.entry.courseId).toBe('course_friday');
    expect(result.last?.date).toEqual({ year: 2026, month: 8, day: 14, weekday: 5 });
    expect(result.next?.entry.courseId).toBe('course_monday');
    expect(result.next?.date).toEqual({ year: 2026, month: 8, day: 17, weekday: 1 });
  });

  it('星期五放學後的 Next 可跨每週課表邊界到下星期一', () => {
    const result = getTimelineScheduleState(
      timetable([entry(5, 8, 'course_friday'), entry(1, 1, 'course_monday')]),
      atTaipei('2026-08-14', '17:30'),
    );
    expect(result.last?.entry.courseId).toBe('course_friday');
    expect(result.next?.entry.courseId).toBe('course_monday');
    expect(result.next?.date).toEqual({ year: 2026, month: 8, day: 17, weekday: 1 });
  });

  it('時間邊界沿用 start <= now < end，結束時該 occurrence 轉為 Last', () => {
    const schedule = timetable([entry(1, 3, 'course_307'), entry(1, 4, 'course_205')]);
    const atStart = getTimelineScheduleState(schedule, atTaipei('2026-08-10', '10:10'));
    expect(atStart.current?.entry.courseId).toBe('course_307');
    expect(atStart.last?.entry.courseId).not.toBe('course_307');
    expect(atStart.next?.entry.courseId).toBe('course_205');

    const atEnd = getTimelineScheduleState(schedule, atTaipei('2026-08-10', '11:00'));
    expect(atEnd.current).toBeNull();
    expect(atEnd.last?.entry.courseId).toBe('course_307');
    expect(atEnd.next?.entry.courseId).toBe('course_205');
  });

  it('signature 只隨 occurrence context 改變，且 default 遵守 fallback', () => {
    const schedule = timetable([entry(1, 1, 'course_307'), entry(1, 2, 'course_205')]);
    const first = getTimelineScheduleState(schedule, atTaipei('2026-08-10', '09:01'));
    const second = getTimelineScheduleState(schedule, atTaipei('2026-08-10', '09:05'));
    expect(second.signature).toBe(first.signature);
    expect(second.signature).toContain('last:course_307:2026-08-10:08:10:09:00');
    expect(second.signature).toContain('next:course_205:2026-08-10:09:10:10:00');
    expect(selectDefaultTimelineRole(first.last, null, first.next)).toBe('next');
    expect(selectDefaultTimelineRole(first.last, null, null)).toBe('last');
    expect(selectDefaultTimelineRole(null, null, null)).toBeNull();
  });
});

describe('Taipei instant', () => {
  it('以明確 UTC+8 算術建立 instant，不使用含糊字串解析', () => {
    expect(taipeiDateToInstant({ year: 2026, month: 8, day: 10 }, '08:10').toISOString())
      .toBe('2026-08-10T00:10:00.000Z');
  });
});
