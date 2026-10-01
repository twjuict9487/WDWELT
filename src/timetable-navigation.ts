export function nextTimetableInputIndex(current: number, total: number, reverse = false): number | null {
  const next = current + (reverse ? -1 : 1);
  return next >= 0 && next < total ? next : null;
}
