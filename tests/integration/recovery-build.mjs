import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const key = randomBytes(48).toString('base64url');
const build = spawnSync(process.execPath, [join(root, 'scripts/build/build-production.mjs')], {
  cwd: root, env: { ...process.env, WDWELT_MASTER_RECOVERY_KEY: key }, encoding: 'utf8', windowsHide: true,
});
assert.equal(build.status, 0, 'Production build failed');
assert.ok(!`${build.stdout}${build.stderr}`.includes(key), 'Build output exposed host secret');
function inspect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (directory === join(root, 'config') && entry.name === 'local') continue;
    const target = join(directory, entry.name);
    if (entry.isDirectory()) inspect(target);
    else assert.ok(!readFileSync(target).includes(Buffer.from(key)), 'Host secret was embedded in an artifact');
  }
}
for (const directory of ['dist', 'src', 'config', 'db/migrations', 'tests']) inspect(join(root, directory));
console.log('Recovery secret build check passed: host-only value absent from bundle, sources, templates, migrations, tests and build output.');
