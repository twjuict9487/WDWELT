import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, relative, resolve } from 'node:path';

export const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'], ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'], ['.txt', 'text/plain; charset=utf-8'],
]);

export function readRelease(root) {
  const metadataPath = join(root, 'build-metadata.json');
  const indexPath = join(root, 'index.html');
  if (!existsSync(indexPath) || !statSync(indexPath).isFile()) throw new Error('必要 static entry index.html 無法讀取');
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8').replace(/^\uFEFF/, ''));
  for (const key of ['releaseLabel', 'version', 'build', 'buildTimestamp']) {
    if (typeof metadata[key] !== 'string' || !metadata[key]) throw new Error(`build metadata 缺少 ${key}`);
  }
  return metadata;
}

export function safeStaticPath(root, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  const candidate = resolve(root, normalize(decoded.replace(/^[/\\]+/, '')));
  const inside = relative(resolve(root), candidate);
  if (inside === '..' || inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) return null;
  return candidate;
}

function json(response, status, body, headOnly = false) {
  const content = Buffer.from(`${JSON.stringify(body)}\n`);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': content.length,
    'Cache-Control': 'no-store',
  });
  if (headOnly) response.end();
  else response.end(content);
}

function serveFile(request, response, filePath) {
  const extension = extname(filePath).toLowerCase();
  const stats = statSync(filePath);
  const cache = extension === '.html' || filePath.endsWith('build-metadata.json')
    ? 'no-store'
    : filePath.includes(`${join('assets', '')}`) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
  response.writeHead(200, {
    'Content-Type': MIME_TYPES.get(extension) ?? 'application/octet-stream',
    'Content-Length': stats.size,
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
  });
  if (request.method === 'HEAD') response.end();
  else createReadStream(filePath).pipe(response);
}

export function createRequestHandler({ root, startedAt = Date.now(), onHealth, checkDatabase = async () => false, currentMigration = async () => 'unavailable', databaseStatus = () => ({ lastCheck: null }) }) {
  return async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        json(response, 405, { status: 'error', message: 'Method not allowed' }, request.method === 'HEAD');
        return;
      }
      if (url.pathname === '/health/live') {
        const metadata = readRelease(root);
        onHealth?.();
        json(response, 200, {
          status: 'ok', version: metadata.version, build: metadata.build,
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000), timestamp: new Date().toISOString(),
          memoryRssBytes: process.memoryUsage().rss,
        }, request.method === 'HEAD');
        return;
      }
      if (url.pathname === '/health' || url.pathname === '/health/ready') {
        const metadata = readRelease(root);
        const databaseReady = await checkDatabase();
        const status = databaseReady ? 'ok' : url.pathname === '/health' ? 'degraded' : 'unavailable';
        onHealth?.();
        json(response, databaseReady ? 200 : 503, {
          status,
          app: 'ok',
          database: databaseReady ? 'ok' : 'unavailable',
          version: metadata.version,
          build: metadata.build,
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
          timestamp: new Date().toISOString(),
          memoryRssBytes: process.memoryUsage().rss,
          migration: databaseReady ? await currentMigration() : 'unavailable',
          databaseLastCheck: databaseStatus().lastCheck,
        }, request.method === 'HEAD');
        return;
      }
      const requestedPath = url.pathname === '/' ? join(root, 'index.html') : safeStaticPath(root, url.pathname);
      if (requestedPath && existsSync(requestedPath) && statSync(requestedPath).isFile()) {
        serveFile(request, response, requestedPath);
        return;
      }
      const looksLikeAsset = extname(url.pathname) !== '' || url.pathname.startsWith('/assets/');
      const acceptsHtml = (request.headers.accept ?? '').includes('text/html');
      if (!looksLikeAsset && acceptsHtml) {
        serveFile(request, response, join(root, 'index.html'));
        return;
      }
      json(response, 404, { status: 'error', message: 'Not found' }, request.method === 'HEAD');
    } catch {
      json(response, 500, { status: 'error', message: 'WDWELT host 無法讀取必要 release files' }, request.method === 'HEAD');
    }
  };
}
