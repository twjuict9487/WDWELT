export const TIMEZONE = 'Asia/Taipei' as const;

export interface Course {
  courseId: string;
  className: string;
}

export interface TimetableEntry {
  weekday: number;
  period: number;
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
  version: 2;
  timetable: Timetable | null;
  courses: Course[];
  progressByCourse: Record<string, CourseProgress>;
}

export interface DraftEntry {
  weekday: number;
  period: number;
  className: string;
}
