import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
const timestamp = new Date().toISOString();
const build = process.env.WDWELT_BUILD_NUMBER?.trim()
  || timestamp.replace(/[-:TZ.]/g, '').slice(0, 14);
const metadata = {
  releaseLabel: 'G2 Pilot',
  version: packageJson.version,
  build,
  buildTimestamp: timestamp,
};

execFileSync(process.execPath, [join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-b'], { cwd: projectRoot, stdio: 'inherit' });
execFileSync(process.execPath, [join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], { cwd: projectRoot, stdio: 'inherit' });
mkdirSync(join(projectRoot, 'dist'), { recursive: true });
writeFileSync(join(projectRoot, 'dist', 'build-metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(`WDWELT ${metadata.releaseLabel} ${metadata.version} build ${metadata.build}`);
