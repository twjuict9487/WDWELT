export type ConnectionState = 'unknown' | 'online' | 'offline';

export interface ConnectionTransition {
  state: ConnectionState;
  restored: boolean;
}

export function connectionTransition(previous: ConnectionState, connected: boolean): ConnectionTransition {
  return {
    state: connected ? 'online' : 'offline',
    restored: connected && previous === 'offline',
  };
}
