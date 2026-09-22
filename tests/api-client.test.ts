import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, loadAccountState, loadCourses, loadCourseProgress, login, saveProgress, verifyRecovery, resetPassword } from '../src/api';

afterEach(() => vi.unstubAllGlobals());

describe('same-origin API client', () => {
  it('uses reset-only same-origin requests without returning a login user or token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(verifyRecovery('teacher', '')).resolves.toBeUndefined();
    await expect(resetPassword('new-password')).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/auth/recovery/verify', '/api/auth/recovery/reset']);
    expect(fetchMock.mock.calls.every(([, options]) => options.credentials === 'same-origin')).toBe(true);
  });
  it('sends credentials and parses a successful login', async () => {
    const session = { authenticated: true, user: { id: 7, username: 'teacher' }, expiresAt: '2026-09-22T10:00:00.000Z', serverTime: '2026-09-22T00:00:00.000Z' };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(session), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(login('teacher', '111')).resolves.toEqual(session);
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({ method: 'POST', credentials: 'same-origin' }));
  });

  it('keeps 401 and 503 distinguishable from transport failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: '請先登入' }), { status: 401 })).mockResolvedValueOnce(new Response('', { status: 503 })));
    await expect(loadAccountState()).rejects.toBeInstanceOf(ApiError);
    await expect(saveProgress('1', 'P.1', '')).rejects.toBeInstanceOf(ApiError);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(loadAccountState()).rejects.toSatisfy((error: unknown) => error instanceof ApiError && error.status === 0);
  });

  it('retries only a failed timetable read once, never a write or 4xx', async () => {
    const ok = new Response(JSON.stringify({ state: { courses: [] } }), { status: 200 });
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(ok);
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadAccountState()).resolves.toEqual({ courses: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const status of [400, 401, 403, 404]) {
      fetchMock.mockReset().mockResolvedValue(new Response('{}', { status }));
      await expect(loadAccountState()).rejects.toMatchObject({ status });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
    fetchMock.mockReset().mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(loadAccountState()).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockReset().mockRejectedValue(new Error('offline'));
    await expect(saveProgress('1', 'P.1', '')).rejects.toMatchObject({ status: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry an aborted read', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation(() => { controller.abort(); return Promise.reject(new DOMException('Aborted', 'AbortError')); });
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadAccountState(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries course and progress reads once on 5xx, without retrying empty success', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 503 })).mockResolvedValueOnce(new Response(JSON.stringify({ courses: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadCourses()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify({ progress: null }), { status: 200 }));
    await expect(loadCourseProgress('7')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
