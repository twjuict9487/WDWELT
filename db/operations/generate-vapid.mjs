import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import webpush from 'web-push';

const arg = (name) => { const i=process.argv.indexOf(name); return i>=0 ? process.argv[i+1] : null; };
const output=arg('--output'); const subject=arg('--subject');
let subjectUrl;
try { subjectUrl = new URL(subject); } catch { /* validation below */ }
if (!output || !subjectUrl || !['mailto:','https:'].includes(subjectUrl.protocol) || (subjectUrl.protocol === 'mailto:' && !subjectUrl.pathname.includes('@'))) { console.error('Required: --output <config/local/push.json> --subject <mailto or HTTPS contact URI>'); process.exitCode=1; }
else {
  const path=resolve(output); const preserve=process.argv.includes('--preserve-keys');
  const keys=preserve && existsSync(path) ? JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,'')) : webpush.generateVAPIDKeys();
  if(!keys.publicKey||!keys.privateKey) throw new Error('Existing VAPID key file is invalid');
  mkdirSync(dirname(path),{recursive:true}); writeFileSync(path, `${JSON.stringify({subject,publicKey:keys.publicKey,privateKey:keys.privateKey},null,2)}\n`, {encoding:'utf8',mode:0o600});
  console.log(JSON.stringify({created:path,publicKey:keys.publicKey,keysPreserved:preserve},null,2));
}
