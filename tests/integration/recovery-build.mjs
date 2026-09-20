import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const build = spawnSync(process.execPath, [join(root, 'scripts/build/build-production.mjs')], {
  cwd: root, encoding: 'utf8', windowsHide: true,
});
assert.equal(build.status, 0, 'Production build failed');

function inspect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (directory === join(root, 'config') && entry.name === 'local') continue;
    const target = join(directory, entry.name);
    if (entry.isDirectory()) inspect(target);
    else assert.ok(!/recovery_config|hash_parameters|password_hash/.test(readFileSync(target, 'utf8')), 'Backend recovery storage leaked into frontend artifact');
  }
}
for (const directory of ['dist']) inspect(join(root, directory));
console.log('Recovery build check passed: database recovery implementation is absent from frontend artifacts.');
