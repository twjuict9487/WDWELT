import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toTaipeiIsoString } from '../../db/core/time.mjs';

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const outputIndex=process.argv.indexOf('--output');
const outputRoot=resolve(projectRoot,outputIndex<0?'dist':process.argv[outputIndex+1]??'');
const outputRelative=relative(projectRoot,outputRoot);
if(isAbsolute(outputRelative)||!['dist','runtime/learning-build'].includes(outputRelative.replace(/\\/g,'/')))throw new Error('Build output must be dist or the isolated runtime/learning-build directory.');
const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
execFileSync(process.execPath, [join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-b'], { cwd: projectRoot, stdio: 'inherit' });
execFileSync(process.execPath, [join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js'), 'build','--outDir',outputRoot], { cwd: projectRoot, stdio: 'inherit' });
const timestamp = toTaipeiIsoString();
const build = process.env.WDWELT_BUILD_NUMBER?.trim()
  || timestamp.replace(/[-:TZ.]/g, '').slice(0, 14);
const metadata = {
  releaseLabel: 'G2 Pilot',
  version: packageJson.version,
  build,
  buildTimestamp: timestamp,
};
mkdirSync(outputRoot, { recursive: true });
writeFileSync(join(outputRoot, 'build-metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(`WDWELT ${metadata.releaseLabel} ${metadata.version} build ${metadata.build}`);
