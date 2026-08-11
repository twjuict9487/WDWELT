import { normalizeClassName } from './storage';

export interface ProgressDraft {
  progress: string;
  note: string;
}

export function normalizeProgressDraft(progress: string, note: string): ProgressDraft {
  return {
    progress: progress.trim(),
    note: note.trim(),
  };
}

export function progressDraftChanged(original: ProgressDraft, current: ProgressDraft): boolean {
  return original.progress !== current.progress || original.note !== current.note;
}

export function timetableDraftSnapshot(values: Iterable<readonly [string, string]>): string {
  return JSON.stringify(
    [...values]
      .map(([key, value]) => [key, normalizeClassName(value)] as const)
      .filter(([, value]) => value.length > 0)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}
