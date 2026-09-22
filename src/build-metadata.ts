export interface BuildMetadata {
  releaseLabel: string;
  version: string;
  build: string;
  buildTimestamp: string;
}

export function formatBuildTime(timestamp: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}/${part('month')}/${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
}

export async function loadBuildMetadata(fetcher: typeof fetch = fetch): Promise<BuildMetadata> {
  const response = await fetcher('/build-metadata.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('metadata request failed');
  const value = await response.json() as Partial<BuildMetadata>;
  for (const key of ['releaseLabel', 'version', 'build', 'buildTimestamp'] as const) {
    if (typeof value[key] !== 'string' || !value[key]) throw new Error(`metadata missing ${key}`);
  }
  return value as BuildMetadata;
}

export async function loadHostHealth(fetcher: typeof fetch = fetch): Promise<'Connected' | 'Host unavailable'> {
  try {
    await fetcher('/health', { cache: 'no-store', signal: AbortSignal.timeout(5_000) });
    return 'Connected';
  } catch { return 'Host unavailable'; }
}
