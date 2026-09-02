import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

export function createLogger({ logPath, retentionDays = 14, maxBytes = 5_000_000, release = {} }) {
  const directory = resolve(logPath);
  mkdirSync(directory, { recursive: true });
  const active = join(directory, 'wdwelt.jsonl');
  const rotate = () => {
    try {
      if (existsSync(active) && statSync(active).size >= maxBytes) {
        renameSync(active, join(directory, `wdwelt-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`));
      }
      const cutoff = Date.now() - retentionDays * 86_400_000;
      for (const name of readdirSync(directory)) {
        const target = resolve(directory, name);
        if (!/^wdwelt-.*\.jsonl$/.test(basename(target)) || !target.startsWith(`${directory}\\`) && !target.startsWith(`${directory}/`)) continue;
        if (statSync(target).mtimeMs < cutoff) unlinkSync(target);
      }
    } catch { /* rotation must never crash hosting */ }
  };
  return (level, event, message) => {
    rotate();
    const record = { timestamp: new Date().toISOString(), level, event, version: release.version ?? 'unknown', build: release.build ?? 'unknown', message };
    try { appendFileSync(active, `${JSON.stringify(record)}\n`, 'utf8'); } catch { /* hosting remains available */ }
  };
}
