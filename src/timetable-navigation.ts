export function nextTimetableInputIndex(current: number, total: number, reverse = false, weekdayColumns = 5): number | null {
  const next = current + (reverse ? -weekdayColumns : weekdayColumns);
  return next >= 0 && next < total ? next : null;
}
