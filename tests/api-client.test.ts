import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, loadAccountState, login, saveProgress } from '../src/api';

afterEach(() => vi.unstubAllGlobals());

describe('same-origin API client', () => {
  it('sends credentials and parses a successful login', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ authenticated: true, user: { id: 7, username: 'teacher' } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(login('teacher', '111')).resolves.toEqual({ id: 7, username: 'teacher' });
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({ method: 'POST', credentials: 'same-origin' }));
  });

  it('keeps 401 and 503 distinguishable from transport failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: '請先登入' }), { status: 401 })).mockResolvedValueOnce(new Response('', { status: 503 })));
    await expect(loadAccountState()).rejects.toBeInstanceOf(ApiError);
    await expect(saveProgress('1', 'P.1', '')).rejects.toBeInstanceOf(ApiError);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(loadAccountState()).rejects.toSatisfy((error: unknown) => error instanceof ApiError && error.status === 0);
  });
});
