import { describe, expect, it } from 'vitest';
import {
  normalizeProgressDraft,
  progressDraftChanged,
  timetableDraftSnapshot,
} from '../src/drafts';

describe('進度草稿 dirty 判斷', () => {
  it('只有實際資料不同才視為已修改', () => {
    const original = normalizeProgressDraft('P.56', '例題 3-2');
    expect(progressDraftChanged(original, normalizeProgressDraft('P.57', '例題 3-2'))).toBe(true);
    expect(progressDraftChanged(original, normalizeProgressDraft(' P.56 ', ' 例題 3-2 '))).toBe(false);
  });

  it('修改後恢復原值不再視為 dirty', () => {
    const original = normalizeProgressDraft('P.56', '');
    const changed = normalizeProgressDraft('P.57', '');
    const restored = normalizeProgressDraft('P.56', '');
    expect(progressDraftChanged(original, changed)).toBe(true);
    expect(progressDraftChanged(original, restored)).toBe(false);
  });
});

describe('課表草稿 dirty 判斷', () => {
  it('忽略輸入順序及不影響資料的空白正規化', () => {
    const original = timetableDraftSnapshot([
      ['1:1', '307'],
      ['2:1', ' 205 '],
    ]);
    const same = timetableDraftSnapshot([
      ['2:1', '205'],
      ['1:1', '  307  '],
      ['3:1', ''],
    ]);
    expect(same).toBe(original);
  });

  it('修改後恢復原值會回到相同 snapshot', () => {
    const original = timetableDraftSnapshot([['1:1', '307']]);
    const changed = timetableDraftSnapshot([['1:1', '308']]);
    const restored = timetableDraftSnapshot([['1:1', '307']]);
    expect(changed).not.toBe(original);
    expect(restored).toBe(original);
  });
});
