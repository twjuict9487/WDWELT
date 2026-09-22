import { describe, expect, it } from 'vitest';
import { readRememberedUsername, rememberUsername, REMEMBERED_USERNAME_KEY, sessionRemainingMs, SESSION_WARNING_MS } from '../src/session';

describe('session UI preferences and warning clock', () => {
  it('stores only the confirmed username under one key', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } } as Storage;
    rememberUsername(storage, 'TeacherA');
    expect([...values]).toEqual([[REMEMBERED_USERNAME_KEY, 'TeacherA']]);
    expect(readRememberedUsername(storage)).toBe('TeacherA');
    rememberUsername(storage, 'TeacherB');
    expect(readRememberedUsername(storage)).toBe('TeacherB');
  });

  it('uses backend expiry and elapsed monotonic time for the five-minute threshold', () => {
    const session = { user: { id: 1, username: 'Teacher' }, serverTime: '2026-09-22T00:00:00.000Z', expiresAt: '2026-09-22T10:00:00.000Z' };
    expect(sessionRemainingMs(session, 0)).toBe(10 * 60 * 60 * 1000);
    expect(sessionRemainingMs(session, 10 * 60 * 60 * 1000 - SESSION_WARNING_MS - 1)).toBe(SESSION_WARNING_MS + 1);
    expect(sessionRemainingMs(session, 10 * 60 * 60 * 1000 - SESSION_WARNING_MS)).toBe(SESSION_WARNING_MS);
    expect(sessionRemainingMs(session, 10 * 60 * 60 * 1000)).toBe(0);
  });
});
