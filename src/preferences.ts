export const PREFERENCES_KEY = 'today-progress-g1:preferences:v1';

export type Theme = 'dark' | 'light';
export type FontSize = 'small' | 'medium' | 'large';

export interface Preferences {
  theme: Theme;
  fontSize: FontSize;
}

export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'dark',
  fontSize: 'medium',
};

export function loadPreferences(storage: PreferenceStorage = localStorage): Preferences {
  const raw = storage.getItem(PREFERENCES_KEY);
  if (!raw) return { ...DEFAULT_PREFERENCES };
  try {
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    return {
      theme: parsed.theme === 'light' || parsed.theme === 'dark' ? parsed.theme : 'dark',
      fontSize: parsed.fontSize === 'small' || parsed.fontSize === 'medium' || parsed.fontSize === 'large'
        ? parsed.fontSize
        : 'medium',
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function savePreferences(
  preferences: Preferences,
  storage: PreferenceStorage = localStorage,
): void {
  storage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
}
