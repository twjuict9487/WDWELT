export function debugModeEnabled(search: string): boolean {
  return new URLSearchParams(search).get('debug') === '1';
}

export function effectiveDebugDate(search: string, debugNow: Date | null, liveNow = new Date()): Date {
  return debugModeEnabled(search) && debugNow ? new Date(debugNow) : new Date(liveNow);
}
