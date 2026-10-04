import type { AppState } from './types';

export interface TimetableDeletionImpact {
  timetableEntries: number;
  unusedCourses: number;
  progressRecords: number;
}

export function timetableDeletionImpact(state: AppState): TimetableDeletionImpact {
  const unusedCourseIds = new Set(state.courses.map((course) => course.courseId));
  return {
    timetableEntries: state.timetable?.entries.length ?? 0,
    unusedCourses: unusedCourseIds.size,
    progressRecords: [...unusedCourseIds].filter((courseId) => state.progressByCourse[courseId] !== undefined).length,
  };
}
