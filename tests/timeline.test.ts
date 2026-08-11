import { describe, expect, it } from 'vitest';
import {
  orderedTimelineRoles,
  resolveTimelineSelection,
  shouldCenterTimelineCard,
} from '../src/timeline';

describe('timeline 展開選擇', () => {
  it('context signature 不變時保留使用者手動選擇', () => {
    expect(resolveTimelineSelection({
      previousRole: 'next',
      previousSignature: 'same-context',
      nextSignature: 'same-context',
      availableRoles: ['last', 'current', 'next'],
      defaultRole: 'current',
    })).toBe('next');
  });

  it('context 改變時重新套用新的 default', () => {
    expect(resolveTimelineSelection({
      previousRole: 'next',
      previousSignature: 'current-307',
      nextSignature: 'gap-after-307',
      availableRoles: ['last', 'next'],
      defaultRole: 'next',
    })).toBe('next');
    expect(resolveTimelineSelection({
      previousRole: 'last',
      previousSignature: 'gap-before-205',
      nextSignature: 'current-205',
      availableRoles: ['last', 'current', 'next'],
      defaultRole: 'current',
    })).toBe('current');
  });

  it('目前選擇消失時回到 default，沒有 context 時可回傳 null', () => {
    expect(resolveTimelineSelection({
      previousRole: 'current',
      previousSignature: 'same',
      nextSignature: 'same',
      availableRoles: ['last', 'next'],
      defaultRole: 'next',
    })).toBe('next');
    expect(resolveTimelineSelection({
      previousRole: null,
      previousSignature: '',
      nextSignature: '',
      availableRoles: [],
      defaultRole: null,
    })).toBeNull();
  });
});

describe('timeline 卡片互動規則', () => {
  it('DOM 角色順序永遠是 Last、Current、Next，缺少者直接省略', () => {
    expect(orderedTimelineRoles({ next: {}, last: {}, current: {} }))
      .toEqual(['last', 'current', 'next']);
    expect(orderedTimelineRoles({ next: {}, last: {} }))
      .toEqual(['last', 'next']);
  });

  it('卡片完整位於 viewport 時不置中，任何一側超出才需要置中', () => {
    expect(shouldCenterTimelineCard(20, 820, 844)).toBe(false);
    expect(shouldCenterTimelineCard(-1, 600, 844)).toBe(true);
    expect(shouldCenterTimelineCard(200, 845, 844)).toBe(true);
  });
});
