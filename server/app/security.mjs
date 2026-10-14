const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function normalizedOrigin(value, name) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    return url.origin;
  } catch { throw new Error(`${name} 必須是沒有 path、query 或 credential 的 HTTP(S) origin`); }
}

export function createSecurityPolicy(config = {}) {
  const exposureMode = config.exposureMode ?? 'lan';
  if (!['lan', 'tailscale-funnel'].includes(exposureMode)) throw new Error('exposureMode 必須是 lan 或 tailscale-funnel');
  const publicOrigin = normalizedOrigin(config.publicOrigin ?? config.canonicalUrl, 'publicOrigin');
  const funnel = exposureMode === 'tailscale-funnel';
  if (funnel && !publicOrigin.startsWith('https://')) throw new Error('Tailscale Funnel publicOrigin 必須使用 HTTPS');
  if (funnel && !new URL(publicOrigin).hostname.endsWith('.ts.net')) throw new Error('Tailscale Funnel publicOrigin 必須使用 tailnet 的 .ts.net DNS 名稱');
  if (funnel && config.bindAddress !== '127.0.0.1') throw new Error('Tailscale Funnel backend 必須只監聽 127.0.0.1');
  return {
    exposureMode,
    publicOrigin,
    secureCookies: funnel,
    requireSameOrigin: funnel,
    allowRegistration: funnel ? config.allowRegistration === true : config.allowRegistration !== false,
    allowMasterRecovery: funnel ? config.allowMasterRecovery === true : config.allowMasterRecovery !== false,
    minimumPasswordLength: funnel ? 12 : 3,
    minimumRecoveryKeyLength: funnel ? 20 : 3,
    rateLimit: funnel ? {
      windowMs: 15 * 60_000,
      loginAttempts: 10,
      recoveryAttempts: 5,
      globalLoginAttempts: 100,
      globalRecoveryAttempts: 20,
      maximumEntries: 2048,
    } : null,
  };
}

export function assertRequestOrigin(request, policy) {
  if (!policy.requireSameOrigin || !UNSAFE_METHODS.has(request.method ?? '')) return;
  if (request.headers.origin !== policy.publicOrigin) {
    const error = new Error('Request origin 不受信任');
    error.status = 403;
    throw error;
  }
}

export function applySecurityHeaders(response, policy) {
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (policy.secureCookies) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

export function createAuthRateLimiter(options) {
  if (!options) return null;
  const attempts = new Map();
  const consume = (kind, key, limit, now = Date.now()) => {
    const id = `${kind}:${String(key).normalize('NFKC').trim().toLocaleLowerCase('en-US')}`;
    if (!attempts.has(id) && attempts.size >= options.maximumEntries) {
      for (const [storedId, stored] of attempts) if (stored.resetAt <= now) attempts.delete(storedId);
      if (attempts.size >= options.maximumEntries) attempts.delete(attempts.keys().next().value);
    }
    const current = attempts.get(id);
    const entry = !current || current.resetAt <= now ? { count: 0, resetAt: now + options.windowMs } : current;
    entry.count += 1;
    attempts.set(id, entry);
    return entry.count <= limit;
  };
  return {
    allowLogin: (key, now) => consume('login-global', '*', options.globalLoginAttempts, now) && consume('login', key, options.loginAttempts, now),
    allowRecovery: (key, now) => consume('recovery-global', '*', options.globalRecoveryAttempts, now) && consume('recovery', key, options.recoveryAttempts, now),
  };
}
