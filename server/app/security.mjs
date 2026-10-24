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
    rateLimit: {
      windowMs: 15 * 60_000,
      loginAttempts: 5,
      recoveryAttempts: 3,
      globalLoginAttempts: funnel ? 300 : 100,
      globalRecoveryAttempts: funnel ? 100 : 20,
      maximumEntries: 4096,
    },
    limits: {
      general: { limit: Number(config.generalRequestsPerMinute ?? 120), windowMs: 60_000 },
      registration: { limit: Number(config.registrationAttemptsPerHour ?? 3), windowMs: 3_600_000 },
      recovery: { limit: Number(config.recoveryAttemptsPerHour ?? 3), windowMs: 3_600_000 },
      push: { limit: Number(config.pushRequestsPerMinute ?? 10), windowMs: 60_000 },
      maximumEntries: 4096,
    },
  };
}

export function createFixedWindowLimiter({ maximumEntries = 4096 } = {}) {
  const entries = new Map();
  return {
    consume(scope, key, { limit, windowMs }, now = Date.now()) {
      const id = `${scope}:${String(key).normalize('NFKC').trim().toLocaleLowerCase('en-US')}`;
      let entry = entries.get(id);
      if (!entry || entry.resetAt <= now) entry = { count: 0, resetAt: now + windowMs };
      if (!entries.has(id) && entries.size >= maximumEntries) {
        for (const [storedId, value] of entries) if (value.resetAt <= now) entries.delete(storedId);
        if (entries.size >= maximumEntries) entries.delete(entries.keys().next().value);
      }
      entry.count += 1; entries.set(id, entry);
      return { allowed: entry.count <= limit, retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
    },
  };
}

export function trustworthyClientKey(request, policy) {
  const remote = request.socket?.remoteAddress ?? 'unknown';
  if (policy.exposureMode === 'tailscale-funnel') {
    const session = typeof request.headers?.cookie === 'string' ? request.headers.cookie.match(/(?:^|;\s*)wdwelt_session=([A-Za-z0-9_-]{40,100})/)?.[1] : null;
    return session ? `session:${session}` : 'funnel-anonymous';
  }
  return `socket:${remote}`;
}

export function assertRequestOrigin(request, policy) {
  if (!UNSAFE_METHODS.has(request.method ?? '')) return;
  if (request.headers['sec-fetch-site'] === 'cross-site') {
    const error = new Error('Request origin 不受信任');
    error.status = 403;
    throw error;
  }
  if (policy.requireSameOrigin && request.headers.origin !== policy.publicOrigin) {
    const error = new Error('Request origin 不受信任');
    error.status = 403;
    throw error;
  }
  if (!policy.requireSameOrigin && request.headers.origin) {
    let originHost = '';
    try { originHost = new URL(request.headers.origin).host; } catch { /* rejected below */ }
    if (!originHost || originHost !== request.headers.host) {
      const error = new Error('Request origin 不受信任');
      error.status = 403;
      throw error;
    }
  }
}

export function applySecurityHeaders(response, policy) {
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
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
  const activeCount = (kind, key, now = Date.now()) => {
    const id = `${kind}:${String(key).normalize('NFKC').trim().toLocaleLowerCase('en-US')}`;
    const entry = attempts.get(id);
    if (!entry || entry.resetAt <= now) { attempts.delete(id); return 0; }
    return entry.count;
  };
  const clear = (kind, key) => attempts.delete(`${kind}:${String(key).normalize('NFKC').trim().toLocaleLowerCase('en-US')}`);
  return {
    allowLogin: (key, now) => consume('login-global', '*', options.globalLoginAttempts, now) && consume('login', key, options.loginAttempts, now),
    allowRecovery: (key, now) => consume('recovery-global', '*', options.globalRecoveryAttempts, now) && consume('recovery', key, options.recoveryAttempts, now),
    isLoginAllowed: (key, now) => activeCount('login-global', '*', now) < options.globalLoginAttempts && activeCount('login', key, now) < options.loginAttempts,
    recordLoginFailure: (key, now) => consume('login-global', '*', options.globalLoginAttempts, now) && consume('login', key, options.loginAttempts, now),
    clearLoginFailures: (key) => clear('login', key),
  };
}
