import { TIMEZONE, type TimetableParseResult } from './types';

export const DEFAULT_PERIODS = [
  { period: 1, start: '08:10', end: '09:00' },
  { period: 2, start: '09:10', end: '10:00' },
  { period: 3, start: '10:10', end: '11:00' },
  { period: 4, start: '11:10', end: '12:00' },
  { period: 5, start: '13:10', end: '14:00' },
  { period: 6, start: '14:10', end: '15:00' },
];

export function createDemoResult(): TimetableParseResult {
  return {
    timezone: TIMEZONE,
    periods: DEFAULT_PERIODS.map((period) => ({ ...period })),
    entries: [
      [1, 1, '化學', '203'], [2, 1, '化學', '307'], [4, 1, '化學', '205'], [5, 1, '化學', '208'],
      [1, 2, '化學', '307'], [3, 2, '化學', '206'], [4, 2, '化學', '203'], [5, 2, '化學', '205'],
      [1, 3, '自然科學', '高307'], [2, 3, '化學', '208'], [3, 3, '化學', '203'], [5, 3, '實驗課', '206'],
      [2, 4, '化學', '205'], [3, 4, '自然科學', '307'], [4, 4, '化學', '208'],
      [1, 5, '實驗課', '206'], [2, 5, '化學', '203'], [4, 5, '化學', '307'], [5, 5, '化學', '205'],
      [1, 6, '化學', '208'], [3, 6, '化學', '205'], [5, 6, '自然科學', '307'],
    ].map(([weekday, period, subject, className]) => ({
      weekday: weekday as number,
      period: period as number,
      subject: subject as string,
      className: className as string,
    })),
    warnings: ['這是 Demo 課表，不是真實圖片辨識結果。儲存前請逐格確認。'],
  };
}
