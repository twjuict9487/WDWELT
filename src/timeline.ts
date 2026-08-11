import type { TimelineRole } from './schedule';

export interface TimelineSelectionInput {
  previousRole: TimelineRole | null;
  previousSignature: string;
  nextSignature: string;
  availableRoles: readonly TimelineRole[];
  defaultRole: TimelineRole | null;
}

export function orderedTimelineRoles(
  availability: Readonly<Partial<Record<TimelineRole, unknown>>>,
): TimelineRole[] {
  return (['last', 'current', 'next'] as const)
    .filter((role) => availability[role] != null);
}

export function shouldCenterTimelineCard(
  top: number,
  bottom: number,
  viewportHeight: number,
): boolean {
  return top < 0 || bottom > viewportHeight;
}

export function resolveTimelineSelection(input: TimelineSelectionInput): TimelineRole | null {
  const contextChanged = input.previousSignature !== input.nextSignature;
  const previousStillExists = input.previousRole !== null
    && input.availableRoles.includes(input.previousRole);
  if (contextChanged || !previousStillExists) return input.defaultRole;
  return input.previousRole;
}
