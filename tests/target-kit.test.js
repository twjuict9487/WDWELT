import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = (path) => readFileSync(resolve(path), 'utf8').replace(/^\uFEFF/, '');
const rootPackage = JSON.parse(source('package.json'));

describe('compact target kit', () => {
  it('keeps target deployment to one setup command with no target-side build pipeline', () => {
    const setup = source('install/compact-target-setup.ps1');
    expect(setup).toContain("Join-Path $kitRoot 'payload.zip'");
    expect(setup).toContain('Assert-Payload');
    expect(setup).toContain("'db\\operations\\target-environment.mjs'");
    expect(setup).toContain("'tools\\wdwelt.ps1'),'install'");
    expect(setup).toContain("'tools\\target-recovery.ps1'");
    expect(setup).toContain("'-DatabaseConfigPath',$runtimeConfig,'-AdminDatabaseConfigPath',$admin");
    expect(setup).toContain("'-CanonicalHost','192.168.0.18','-AllowedRemoteAddress','192.168.0.0/22','-AllowPublicProfile'");
    expect(setup).toContain('profiles=Private,Domain,Public');
    expect(setup).toContain("'start','-ConfigPath',$installedConfig");
    expect(setup).not.toMatch(/npm\s+(?:ci|install|test)|run\s+build/i);
  });

  it('keeps repository setup separate from the generated compact-kit commands', () => {
    expect(rootPackage.scripts.setup).toContain('install/bootstrap.ps1');
    expect(rootPackage.scripts.host).toContain('server/app/server.mjs');
    const builder = source('scripts/build/build-target-kit.ps1');
    expect(builder).toContain("setup='powershell.exe -NoProfile -ExecutionPolicy Bypass -File setup.ps1'");
    expect(builder).toContain("host='powershell.exe -NoProfile -ExecutionPolicy Bypass -File setup.ps1 -StartOnly'");
    expect(builder).toContain("scripts.setup-match'bootstrap|install/bootstrap'");
    expect(builder).toContain("scripts.host-match'server/app|development.json'");
  });

  it('runs tests and build before creating the four-file kit', () => {
    const builder = source('scripts/build/build-target-kit.ps1');
    expect(builder.indexOf('$npmCli test')).toBeLessThan(builder.indexOf('$npmCli run build'));
    expect(builder.indexOf('$npmCli run build')).toBeLessThan(builder.indexOf('package -PackagePath $package'));
    expect(builder).toContain("Compress-Archive -Path (Join-Path $package '*')");
    expect(builder).toContain("name='wdwelt-target-kit'");
    expect(builder).toContain("setup='powershell.exe -NoProfile -ExecutionPolicy Bypass -File setup.ps1'");
    expect(builder).toContain("host='powershell.exe -NoProfile -ExecutionPolicy Bypass -File setup.ps1 -StartOnly'");
    expect(builder).toContain('Assert-ProductionPackage $package');
    expect(builder).toContain('Assert-ProductionPackage $PayloadRoot');
    expect(builder).toContain('Expand-Archive -LiteralPath $zip -DestinationPath $finalVerification');
    expect(builder).toContain('Assert-PowerShellSyntax $script.FullName');
    expect(builder).toContain("@('install\\wdwelt.ps1','tools\\wdwelt.ps1')");
  });

  it('keeps administrative backup credentials separate and fails before update mutation', () => {
    const manager = source('install/wdwelt.ps1');
    const targetDatabase = source('db/operations/target-environment.mjs');
    const backup = source('db/operations/backup.mjs');
    expect(targetDatabase).toContain("database.admin.json'),{...common,user:'root'}");
    expect(targetDatabase).toContain("database.runtime.json'),{...common,user:'wdwelt_app'}");
    expect(targetDatabase).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON `g2`.*');
    expect(targetDatabase).not.toMatch(/GRANT[^\n]*(?:CREATE|DROP|ALTER|LOCK TABLES)[^\n]*wdwelt_app/i);
    expect(manager).toContain("Invoke-DatabaseTool 'backup.mjs' @('--config',[string]$Config.adminDatabaseConfigPath");
    expect(backup).toContain('const config = loadDatabaseConfig(configPath);');
    expect(backup).toContain('const option = createOptionFile(config);');
    expect(backup).toContain('spawn(config.mysqlDumpPath, args');
    const update = manager.slice(manager.indexOf('function Invoke-Update'), manager.indexOf('function Switch-DirectoryPair'));
    const backupIndex = update.indexOf("Invoke-DatabaseBackup 'pre-migration' $package.Root");
    expect(backupIndex).toBeGreaterThan(-1);
    expect(backupIndex).toBeLessThan(update.indexOf("Acquire-MaintenanceLock 'update'"));
    expect(backupIndex).toBeLessThan(update.indexOf('Stop-Wdwelt -Maintenance'));
    expect(backupIndex).toBeLessThan(update.indexOf('Move-Item -LiteralPath $current -Destination $previous'));
  });

  it('omits type-only peer packages and declarations from the runtime payload', () => {
    const copier = source('scripts/build/copy-production-dependencies.mjs');
    expect(copier).toContain('metadata.peer !== true');
    expect(copier).toContain('Review runtime peer dependencies before packaging');
    expect(copier).toContain("entry.endsWith('.d.ts')");
  });
});
