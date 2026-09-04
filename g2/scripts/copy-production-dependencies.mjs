import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = resolve(process.argv[2] ?? '');
const targetRoot = resolve(process.argv[3] ?? '');
const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node copy-production-dependencies.mjs <project-root> <target-node_modules>');
if (!isAbsolute(sourceRoot) || !isAbsolute(targetRoot)) throw new Error('Source and target paths must be absolute.');
const sameProjectRoot = process.platform === 'win32'
  ? sourceRoot.toLocaleLowerCase('en-US') === scriptRoot.toLocaleLowerCase('en-US')
  : sourceRoot === scriptRoot;
if (!sameProjectRoot) throw new Error('Dependency source must be the WDWELT project root.');
if (targetRoot === sourceRoot || targetRoot === resolve(sourceRoot, 'node_modules') || basename(targetRoot) !== 'node_modules') throw new Error('Invalid dependency target.');

const lock = JSON.parse(readFileSync(resolve(sourceRoot, 'package-lock.json'), 'utf8'));
const packages = Object.entries(lock.packages ?? {})
  .filter(([path, metadata]) => path.startsWith('node_modules/') && metadata.dev !== true)
  .map(([path]) => path.replaceAll('/', sep));

if (!packages.includes(`node_modules${sep}mysql2`)) throw new Error('package-lock.json does not contain the mysql2 production dependency.');
if (existsSync(targetRoot)) rmSync(targetRoot, { recursive: true, force: true });
mkdirSync(targetRoot, { recursive: true });

for (const packagePath of packages) {
  const source = resolve(sourceRoot, packagePath);
  if (!existsSync(source)) continue;
  const relative = packagePath.slice(`node_modules${sep}`.length);
  const target = resolve(targetRoot, relative);
  if (!target.startsWith(`${targetRoot}${sep}`)) throw new Error(`Dependency path escaped target: ${packagePath}`);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, dereference: true });
}

console.log(`Copied ${packages.length} production dependency entries.`);
