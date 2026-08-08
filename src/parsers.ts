import { createDemoResult } from './demo';
import type { TimetableParseResult, TimetableParser } from './types';

export class DemoTimetableParser implements TimetableParser {
  parse(_file: File): Promise<TimetableParseResult> {
    return Promise.resolve(createDemoResult());
  }
}

export class ApiTimetableParser implements TimetableParser {
  constructor(private readonly endpoint = '/api/parse-timetable') {}

  async parse(file: File): Promise<TimetableParseResult> {
    const body = new FormData();
    body.append('image', file);

    const response = await fetch(this.endpoint, { method: 'POST', body });
    if (!response.ok) {
      throw new Error(`課表辨識失敗（HTTP ${response.status}）`);
    }
    return (await response.json()) as TimetableParseResult;
  }
}
