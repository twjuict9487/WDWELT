import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createReleaseSchema } from '../db/core/release.mjs';
import { verifyDumpMigrationLedger } from '../db/operations/restore.mjs';

describe('combined application/schema releases', () => {
  it('builds 0.3.0012 with all migration checksums and an account-free fresh schema', () => {
    const { manifest, sql } = createReleaseSchema(resolve('db/migrations'), '0.3.0');
    expect(manifest.version).toBe('0.3.0012');
    expect(manifest.schemaVersion).toBe('0012');
    expect(manifest.applicationVersion).toBe('0.3.0');
    expect(manifest.migrations).toHaveLength(12);
    expect(verifyDumpMigrationLedger(sql, resolve('db/migrations')).migrations).toHaveLength(12);
    expect(sql).not.toMatch(/INSERT INTO [`]?users/i);
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).toContain('CREATE TABLE schema_migrations');
  });
  it('rejects missing and duplicate sequence numbers rather than mislabelling releases', () => {
    const directory = mkdtempSync(join(tmpdir(), 'wdwelt-release-'));
    try {
      expect(() => createReleaseSchema(directory, '0.3.0')).toThrow(/No schema/);
      writeFileSync(join(directory, '002_missing.sql'), 'SELECT 1;');
      expect(() => createReleaseSchema(directory, '0.3.0')).toThrow(/contiguous/);
      writeFileSync(join(directory, '001_initial.sql'), '\uFEFFSELECT 1;');
      expect(createReleaseSchema(directory, '0.3.1').manifest.version).toBe('0.3.0002');
      writeFileSync(join(directory, '001_duplicate.sql'), 'SELECT 1;');
      expect(() => createReleaseSchema(directory, '0.3.0')).toThrow(/contiguous/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
