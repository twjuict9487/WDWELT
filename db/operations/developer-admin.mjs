import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword, normalizeUsername } from '../core/password.mjs';
import { writeProtectedJson } from '../core/config.mjs';

const argument = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; };

export async function writeDeveloperCredentials(path, username, password) {
  const normalized = normalizeUsername(username);
  if (typeof password !== 'string' || password.length < 12) throw new Error('Developer password must be at least 12 characters.');
  const saved = await hashPassword(password);
  writeProtectedJson(path, {
    username: normalized.username,
    normalizedUsername: normalized.normalizedUsername,
    passwordSalt: saved.salt.toString('base64'),
    passwordHash: saved.hash.toString('base64'),
    passwordParameters: saved.parameters,
  });
  return resolve(path);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = argument('--config');
  if (!config) { console.error('Required: --config <config/local/developer-admin.json>; credentials are read as JSON from stdin.'); process.exitCode = 1; }
  else {
    try {
      const body = JSON.parse(readFileSync(0, 'utf8'));
      const path = await writeDeveloperCredentials(resolve(config), body.username, body.password);
      console.log(`Developer credentials securely written to ${path}`);
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
