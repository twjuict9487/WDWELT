export function debugModeEnabled(search: string): boolean {
  const value = new URLSearchParams(search).get('debug');
  return value === '0' || value === '1';
}

export function selfTestModeEnabled(search: string): boolean {
  return new URLSearchParams(search).get('debug') === '0';
}

export function effectiveDebugDate(search: string, debugNow: Date | null, liveNow = new Date()): Date {
  return debugModeEnabled(search) && debugNow ? new Date(debugNow) : new Date(liveNow);
}
