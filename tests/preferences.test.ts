import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_KEY,
  loadPreferences,
  savePreferences,
  type PreferenceStorage,
} from '../src/preferences';

class MemoryStorage implements PreferenceStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('basic settings', () => {
  it('fresh load 預設 dark 與 medium', () => {
    expect(loadPreferences(new MemoryStorage())).toEqual(DEFAULT_PREFERENCES);
  });

  it('theme 與 font size save/load 後保持', () => {
    const storage = new MemoryStorage();
    savePreferences({ theme: 'light', fontSize: 'large' }, storage);
    expect(storage.getItem(PREFERENCES_KEY)).not.toBeNull();
    expect(loadPreferences(storage)).toEqual({ theme: 'light', fontSize: 'large' });
  });

  it('支援 small、medium、large 與 dark、light 的合法組合', () => {
    const storage = new MemoryStorage();
    for (const fontSize of ['small', 'medium', 'large'] as const) {
      for (const theme of ['dark', 'light'] as const) {
        savePreferences({ theme, fontSize }, storage);
        expect(loadPreferences(storage)).toEqual({ theme, fontSize });
      }
    }
  });

  it('損壞或不合法資料回到預設值', () => {
    const storage = new MemoryStorage();
    storage.setItem(PREFERENCES_KEY, '{broken');
    expect(loadPreferences(storage)).toEqual(DEFAULT_PREFERENCES);
    storage.setItem(PREFERENCES_KEY, JSON.stringify({ theme: 'system', fontSize: 'huge' }));
    expect(loadPreferences(storage)).toEqual(DEFAULT_PREFERENCES);
  });
});
