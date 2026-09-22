import type { AuthSession } from './api';

export const REMEMBERED_USERNAME_KEY = 'wdwelt.rememberedUsername';
export const SESSION_WARNING_MS = 5 * 60 * 1000;

export function readRememberedUsername(storage: Storage): string {
  try { return storage.getItem(REMEMBERED_USERNAME_KEY) ?? ''; }
  catch { return ''; }
}

export function rememberUsername(storage: Storage, username: string): void {
  try { storage.setItem(REMEMBERED_USERNAME_KEY, username); }
  catch { /* Login remains usable when storage is unavailable. */ }
}

export function sessionRemainingMs(session: AuthSession, elapsedMs: number): number {
  return Date.parse(session.expiresAt) - Date.parse(session.serverTime) - elapsedMs;
}
