import { formatBuildTime, type BuildMetadata } from './build-metadata';

export function formatDiagnostics(
  metadata: BuildMetadata | null,
  currentUrl: string,
  hostStatus: string,
): string {
  return [
    `Version: ${metadata ? `${metadata.releaseLabel} ${metadata.version}` : '無法確認'}`,
    `Build: ${metadata ? formatBuildTime(metadata.buildTimestamp) : '無法確認'}`,
    `Build ID: ${metadata?.build ?? '無法確認'}`,
    `URL: ${currentUrl}`,
    `Host: ${hostStatus}`,
  ].join('\n');
}
