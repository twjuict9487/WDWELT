import type { AppState, CourseProgress, DraftEntry } from './types';

export interface AuthUser {
  id: number;
  username: string;
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
  } catch { throw new ApiError(0, '無法連線至中央資料服務'); }
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

export async function register(username: string, password: string): Promise<string> {
  return (await request<{ created: true; username: string }>('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) })).username;
}

export async function login(username: string, password: string): Promise<AuthUser> {
  return (await request<{ authenticated: true; user: AuthUser }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) })).user;
}

export async function logout(): Promise<void> {
  await request('/api/auth/logout', { method: 'POST' });
}

export async function currentUser(): Promise<AuthUser> {
  return (await request<{ authenticated: true; user: AuthUser }>('/api/auth/me')).user;
}

export async function loadAccountState(): Promise<AppState> {
  return (await request<{ state: AppState }>('/api/timetable')).state;
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
