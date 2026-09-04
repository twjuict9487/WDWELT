import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = (path) => readFileSync(resolve(path), 'utf8').replace(/^\uFEFF/, '');

describe('G2 source-of-truth and secret boundaries', () => {
  it('keeps timetable and progress persistence out of localStorage', () => {
    const app = source('src/app.ts');
    expect(app).not.toMatch(/\b(?:persistState|loadStateResult|replaceTimetable|updateProgress|restoreProgress)\b/);
    expect(app).toContain("from './api'");
    expect(app).toContain("from './preferences'");
  });

  it('does not accept a client-selected user id in the API client', () => {
    expect(source('src/api.ts')).not.toMatch(/user_?id/i);
  });

  it('keeps credentials out of frontend and VITE configuration', () => {
    const frontend = `${source('src/app.ts')}\n${source('src/api.ts')}\n${source('vite.config.ts')}`;
    expect(frontend).not.toMatch(/VITE_.*(?:PASSWORD|DATABASE|MYSQL)/i);
    expect(frontend).not.toContain('wdwelt_app');
  });

  it('expands database-tool wildcards during installation', () => {
    const manager = source('wdwelt.ps1');
    expect(manager).not.toMatch(/Copy-Item\s+-LiteralPath\s+\(Join-Path\s+\$package\.Root\s+'db\\\*'\)/);
    expect(manager.match(/Copy-Item\s+-Path\s+\(Join-Path\s+\$package\.Root\s+'db\\\*'\)/g)).toHaveLength(2);
  });
});
