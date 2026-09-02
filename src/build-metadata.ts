export interface BuildMetadata {
  releaseLabel: string;
  version: string;
  build: string;
  buildTimestamp: string;
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

export async function loadHostHealth(fetcher: typeof fetch = fetch): Promise<'正常' | '無法確認'> {
  try {
    const response = await fetcher('/health', { cache: 'no-store' });
    if (!response.ok) return '無法確認';
    const value = await response.json() as { status?: unknown };
    return value.status === 'ok' ? '正常' : '無法確認';
  } catch { return '無法確認'; }
}
