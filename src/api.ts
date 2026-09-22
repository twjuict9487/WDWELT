import type { AppState, CourseProgress, DraftEntry } from './types';

export interface AuthUser {
  id: number;
  username: string;
}

export interface AuthSession {
  user: AuthUser;
  expiresAt: string;
  serverTime: string;
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      headers: options.body ? { 'Content-Type': 'application/json', ...options.headers } : options.headers,
    });
  } catch (error) {
    if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
    throw new ApiError(0, '無法連線至中央資料服務');
  }
  let payload: unknown = null;
  try { payload = await response.json(); } catch { /* status below supplies a safe message */ }
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
      ? payload.error
      : response.status === 503 ? '中央資料目前無法使用' : '伺服器處理失敗';
    throw new ApiError(response.status, message);
  }
  return payload as T;
}

async function readWithRetry<T>(path: string, signal?: AbortSignal): Promise<T> {
  try { return await request<T>(path, { signal }); }
  catch (error) {
    if (!(error instanceof ApiError) || (error.status !== 0 && error.status < 500) || signal?.aborted) throw error;
    await new Promise<void>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 350);
      const abort = () => { globalThis.clearTimeout(timer); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')); };
      signal?.addEventListener('abort', abort, { once: true });
    });
    return request<T>(path, { signal });
  }
}

export async function register(username: string, password: string): Promise<string> {
  return (await request<{ created: true; username: string }>('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) })).username;
}

export async function login(username: string, password: string): Promise<AuthSession> {
  return request<{ authenticated: true } & AuthSession>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
}

export async function verifyRecovery(username: string, recoveryKey: string): Promise<void> {
  await request('/api/auth/recovery/verify', { method: 'POST', body: JSON.stringify({ username, recoveryKey }) });
}

export async function resetPassword(password: string): Promise<void> {
  await request('/api/auth/recovery/reset', { method: 'POST', body: JSON.stringify({ password }) });
}

export async function logout(): Promise<void> {
  await request('/api/auth/logout', { method: 'POST' });
}

export async function currentUser(): Promise<AuthSession> {
  return request<{ authenticated: true } & AuthSession>('/api/auth/me');
}

export async function loadAccountState(signal?: AbortSignal): Promise<AppState> {
  return (await readWithRetry<{ state: AppState }>('/api/timetable', signal)).state;
}

export async function loadCourses(signal?: AbortSignal): Promise<AppState['courses']> {
  return (await readWithRetry<{ courses: AppState['courses'] }>('/api/courses', signal)).courses;
}

export async function loadCourseProgress(courseId: string, signal?: AbortSignal): Promise<CourseProgress | null> {
  return (await readWithRetry<{ progress: CourseProgress | null }>(`/api/progress/${encodeURIComponent(courseId)}`, signal)).progress;
}

export async function saveTimetable(entries: DraftEntry[]): Promise<AppState> {
  return (await request<{ state: AppState }>('/api/timetable', { method: 'PUT', body: JSON.stringify({ entries }) })).state;
}

export async function removeTimetable(): Promise<AppState> {
  return (await request<{ state: AppState }>('/api/timetable', { method: 'DELETE' })).state;
}

export async function saveProgress(courseId: string, progress: string, note: string): Promise<CourseProgress> {
  return (await request<{ progress: CourseProgress }>(`/api/progress/${encodeURIComponent(courseId)}`, { method: 'PUT', body: JSON.stringify({ progress, note }) })).progress;
}

export async function removeProgress(courseId: string): Promise<void> {
  await request(`/api/progress/${encodeURIComponent(courseId)}`, { method: 'DELETE' });
}

export async function clearProgress(): Promise<void> {
  await request('/api/progress', { method: 'DELETE' });
}
