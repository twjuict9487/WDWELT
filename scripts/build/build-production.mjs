import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toTaipeiIsoString } from '../../db/core/time.mjs';
import { createReleaseSchema } from '../../db/core/release.mjs';

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const outputIndex=process.argv.indexOf('--output');
const outputRoot=resolve(projectRoot,outputIndex<0?'dist':process.argv[outputIndex+1]??'');
const outputRelative=relative(projectRoot,outputRoot);
if(isAbsolute(outputRelative)||!['dist','runtime/learning-build'].includes(outputRelative.replace(/\\/g,'/')))throw new Error('Build output must be dist or the isolated runtime/learning-build directory.');
const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
const schema = createReleaseSchema(join(projectRoot, 'db/migrations'), packageJson.version);
execFileSync(process.execPath, [join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-b'], { cwd: projectRoot, stdio: 'inherit' });
execFileSync(process.execPath, [join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js'), 'build','--outDir',outputRoot], { cwd: projectRoot, stdio: 'inherit' });
const timestamp = toTaipeiIsoString();
const build = process.env.WDWELT_BUILD_NUMBER?.trim()
  || timestamp.replace(/[-:TZ.]/g, '').slice(0, 14);
const metadata = {
  releaseLabel: 'G2 Pilot',
  version: schema.manifest.version,
  applicationVersion: packageJson.version,
  schemaVersion: schema.manifest.schemaVersion,
  build,
  buildTimestamp: timestamp,
};
mkdirSync(outputRoot, { recursive: true });
writeFileSync(join(outputRoot, 'build-metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
// SQL stays outside the web root: a deployment artifact, never a public asset.
const databaseOutput = join(projectRoot, 'runtime', 'release-database', metadata.build.replace(/[^a-zA-Z0-9_-]/g, '_'));
mkdirSync(databaseOutput, { recursive: true });
writeFileSync(join(databaseOutput, 'schema-manifest.json'), `${JSON.stringify(schema.manifest, null, 2)}\n`);
writeFileSync(join(databaseOutput, 'wdwelt.sql'), schema.sql);
console.log(`Database release artifacts: ${databaseOutput}`);
console.log(`WDWELT ${metadata.releaseLabel} ${metadata.version} build ${metadata.build}`);
