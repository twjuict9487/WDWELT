import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bootstrapPath = resolve(repositoryRoot, 'install', 'bootstrap.ps1');
const launcherPath = resolve(repositoryRoot, 'install', 'START-WDWELT.cmd');
const managerPath = resolve(repositoryRoot, 'install', 'wdwelt.ps1');
const deploymentSettingsPath = resolve(repositoryRoot, 'install', 'deployment.settings.json');

describe('one-file Windows bootstrap', () => {
  const windowsIt = process.platform === 'win32' ? it : it.skip;

  windowsIt('parses and prints a no-write plan from an unrelated working directory', () => {
    const logDirectory = resolve(repositoryRoot, 'runtime', 'logs');
    const bootstrapLogs = () => existsSync(logDirectory)
      ? readdirSync(logDirectory).filter((name) => name.startsWith('bootstrap-')).sort()
      : [];
    const before = bootstrapLogs();
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bootstrapPath, '-PlanOnly'],
      { cwd: tmpdir(), encoding: 'utf8', timeout: 15_000 },
    );

    expect(output).toContain('WDWELT one-file bootstrap plan');
    expect(output).toContain('PlanOnly');
    expect(output).toContain('never opens MySQL 3306');
    expect(bootstrapLogs()).toEqual(before);
  });

  it('anchors every repository path to the script location', () => {
    const bootstrap = readFileSync(bootstrapPath, 'utf8');
    const launcher = readFileSync(launcherPath, 'utf8');

    expect(bootstrap).toContain('$InstallDirectory = [IO.Path]::GetFullPath($PSScriptRoot)');
    expect(bootstrap).toContain("$RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $InstallDirectory '..'))");
    expect(launcher).toContain('"%~dp0bootstrap.ps1"');
  });

  it('keeps credentials out of process arguments and redacts secret-like log arguments', () => {
    const bootstrap = readFileSync(bootstrapPath, 'utf8');

    expect(bootstrap).toContain('Read-Host \'請輸入 MySQL root 密碼（畫面不會顯示）\' -AsSecureString');
    expect(bootstrap).toContain('--defaults-extra-file=$optionFile');
    expect(bootstrap).toContain("(?:password|passwd|token|secret)");
    expect(bootstrap).not.toMatch(/root_passwd/i);
  });

  it('limits MySQL to localhost and delegates the firewall to the reviewed installer', () => {
    const bootstrap = readFileSync(bootstrapPath, 'utf8');

    expect(bootstrap).toContain('bind-address=127.0.0.1');
    expect(bootstrap).toContain('wdwelt-before-localhost-');
    expect(bootstrap).not.toContain('New-NetFirewallRule');
    expect(bootstrap).toContain('& $packageTool install @installParameters -DryRun');
  });

  it('uses reviewed package identifiers and keeps the phase counter synchronized', () => {
    const bootstrap = readFileSync(bootstrapPath, 'utf8');
    const main = bootstrap.slice(bootstrap.indexOf('function Main'));

    expect(bootstrap).toContain("'OpenJS.NodeJS.LTS'");
    expect(bootstrap).toContain("'Oracle.MySQL'");
    expect(bootstrap).toContain('$PhaseCount = 13');
    expect(main.match(/\bWrite-Phase\b/g)).toHaveLength(13);
  });

  it('loads production network values from one deployment settings file', () => {
    const bootstrap = readFileSync(bootstrapPath, 'utf8');
    const manager = readFileSync(managerPath, 'utf8');
    const settings = JSON.parse(readFileSync(deploymentSettingsPath, 'utf8'));
    const main = bootstrap.slice(bootstrap.indexOf('function Main'));

    expect(settings).toMatchObject({ hostAddress: '192.168.0.18', subnetCidr: '192.168.0.0/22', defaultGateway: '192.168.1.254' });
    expect(settings.allowedClientRanges).toEqual(['192.168.0.0/22']);
    for (const source of [bootstrap, manager]) expect(source).toContain('Read-DeploymentSettings');
    expect(bootstrap).not.toContain('Select-CanonicalHost');
    expect(main.indexOf('$lanIp = Assert-ProductionNetwork')).toBeLessThan(main.indexOf('$node = Ensure-Node'));
    expect(manager).toContain('-LocalAddress ([string]$Config.canonicalHost) -RemoteAddress $remoteAddresses');
    expect(manager).toContain('-EdgeTraversalPolicy Block');
    expect(manager).toContain("tools\\deployment.settings.json");
    expect(manager).toContain('Firewall remote CIDR 必須完整位於 RFC1918 private range');
    expect(manager).not.toMatch(/New-NetFirewallRule[^\r\n]+-RemoteAddress\s+LocalSubnet/);
    for (const source of [bootstrap, manager]) expect(source).not.toMatch(/\$host\b/i);
  });

  windowsIt('accepts a different validated private environment through one file', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'wdwelt-settings-'));
    const settingsPath = resolve(directory, 'deployment.settings.json');
    try {
      writeFileSync(settingsPath, JSON.stringify({
        schemaVersion: 1,
        environmentName: 'alternate-school',
        hostAddress: '10.20.30.18',
        subnetCidr: '10.20.30.0/24',
        defaultGateway: '10.20.30.1',
        allowedClientRanges: ['10.20.30.0/24'],
      }));
      const output = execFileSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bootstrapPath,
        '-PlanOnly', '-DeploymentSettingsPath', settingsPath,
      ], { cwd: tmpdir(), encoding: 'utf8', timeout: 15_000 });
      expect(output).toContain('Settings: alternate-school');
      expect(output).toContain('Require 10.20.30.18/24 and gateway 10.20.30.1');
      expect(output).toContain('10.20.30.0/24-only firewall rule');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('supports a fail-closed offline preparation path', () => {
    const bootstrap = readFileSync(bootstrapPath, 'utf8');
    const gitignore = readFileSync(resolve(repositoryRoot, '.gitignore'), 'utf8');

    expect(bootstrap).toContain('[switch]$Offline');
    expect(bootstrap).toContain('[string]$NodeInstallerPath');
    expect(bootstrap).toContain('[string]$MySqlInstallerPath');
    expect(bootstrap).toContain('[string]$NpmCachePath');
    expect(bootstrap).toContain("@('--offline','--cache',$offlineCache)");
    expect(bootstrap).toContain('Offline 模式不能使用 MySQL web installer');
    expect(bootstrap).toContain('Get-AuthenticodeSignature');
    expect(gitignore).toContain('install/offline/');
  });

  it('is encoded for Windows PowerShell and cmd.exe', () => {
    const bootstrap = readFileSync(bootstrapPath);
    const launcher = readFileSync(launcherPath, 'utf8');

    expect([...bootstrap.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(launcher).not.toMatch(/(?<!\r)\n/);
  });
});
