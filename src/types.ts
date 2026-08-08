export const TIMEZONE = 'Asia/Taipei' as const;

export interface Course {
  courseId: string;
  subject: string;
  className: string;
}

export interface TimetableEntry {
  weekday: number;
  period: number;
  start: string;
  end: string;
  courseId: string;
}

export interface Timetable {
  timezone: typeof TIMEZONE;
  entries: TimetableEntry[];
  updatedAt: string;
}

export interface CourseProgress {
  courseId: string;
  progress: string;
  note: string;
  updatedAt: string;
}

export interface AppState {
  version: 1;
  timetable: Timetable | null;
  courses: Course[];
  progressByCourse: Record<string, CourseProgress>;
}

export interface ParserPeriod {
  period: number;
  start: string;
  end: string;
}

export interface ParserEntry {
  weekday: number;
  period: number;
  subject: string;
  className: string;
}

export interface TimetableParseResult {
  timezone: typeof TIMEZONE;
  periods: ParserPeriod[];
  entries: ParserEntry[];
  warnings: string[];
}

export interface TimetableParser {
  parse(file: File): Promise<TimetableParseResult>;
}

export interface DraftEntry extends ParserEntry {
  start: string;
  end: string;
}
