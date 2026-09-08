import { randomUUID } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { protectLocalFile } from './config.mjs';

const optionValue = (value) => {
  const text = String(value ?? '');
  if (/[\r\n]/.test(text)) throw new Error('Invalid MySQL option value');
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
};

export function createTemporaryOptionFile(config) {
  const optionPath = join(tmpdir(), `wdwelt-mysql-${randomUUID()}.cnf`);
  const content = [
    '[client]',
    `host=${optionValue(config.host)}`,
    `port=${config.port}`,
    `user=${optionValue(config.user)}`,
    `password=${optionValue(config.password)}`,
    '',
  ].join('\n');
  writeFileSync(optionPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    protectLocalFile(optionPath);
  } catch (error) { try { unlinkSync(optionPath); } catch { /* preserve original ACL error */ } throw error; }
  return { optionPath, remove: () => { try { unlinkSync(optionPath); } catch { /* best effort */ } } };
}
