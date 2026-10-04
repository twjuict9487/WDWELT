import { describe, expect, it } from 'vitest';
import { connectionTransition } from '../src/connectivity';

describe('connection transitions', () => {
  it('only reports restoration after a detected offline state', () => {
    expect(connectionTransition('unknown', true)).toEqual({ state: 'online', restored: false });
    expect(connectionTransition('online', true)).toEqual({ state: 'online', restored: false });
    expect(connectionTransition('online', false)).toEqual({ state: 'offline', restored: false });
    expect(connectionTransition('offline', true)).toEqual({ state: 'online', restored: true });
  });
});
