import { describe, expect, it } from 'vitest';
import { formatDiagnostics } from '../src/diagnostics';

describe('diagnostics formatting', () => {
  it('includes the requested compact build and connection fields', () => {
    expect(formatDiagnostics({
      releaseLabel: 'G2 Pilot', version: '0.3.0', build: 'abc123', buildTimestamp: '2026-10-05T01:02:03.000Z',
    }, 'http://192.168.0.18:8080/settings', 'Connected')).toBe([
      'Version: G2 Pilot 0.3.0',
      'Build: 2026/10/05 09:02:03',
      'Build ID: abc123',
      'URL: http://192.168.0.18:8080/settings',
      'Host: Connected',
    ].join('\n'));
  });
});
