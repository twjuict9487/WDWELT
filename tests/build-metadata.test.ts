import { describe, expect, it, vi } from 'vitest';
import { formatBuildTime, loadBuildMetadata, loadHostHealth } from '../src/build-metadata';

describe('artifact metadata and host status', () => {
  it('formats the artifact timestamp in Taipei and reads the same metadata on reload', async () => {
    const metadata = { releaseLabel: 'G2 Pilot', version: '0.3.0', build: 'test-42', buildTimestamp: '2026-09-22T12:08:31.000Z' };
    const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify(metadata), { status: 200 }));
    expect(formatBuildTime(metadata.buildTimestamp)).toBe('2026/09/22 20:08:31');
    expect(await loadBuildMetadata(fetcher)).toEqual(metadata);
    expect(await loadBuildMetadata(fetcher)).toEqual(metadata);
  });

  it('treats any HTTP response as a connected host and transport errors as unavailable', async () => {
    for (const status of [200, 401, 403, 404, 503]) {
      expect(await loadHostHealth(vi.fn().mockResolvedValue(new Response('', { status })))).toBe('Connected');
    }
    expect(await loadHostHealth(vi.fn().mockRejectedValue(new Error('connection refused')))).toBe('Host unavailable');
  });
});
