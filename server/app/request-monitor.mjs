import { createHash, randomBytes } from 'node:crypto';

const minuteKey = (time) => Math.floor(time / 60_000);
const routeName = (rawUrl = '/') => {
  let path = '/';
  try { path = new URL(rawUrl, 'http://localhost').pathname; } catch { /* retain root */ }
  return path
    .replace(/^\/api\/privileged\/accounts\/\d+\/label$/, '/api/privileged/accounts/:id/label')
    .replace(/^\/api\/progress\/[^/]+$/, '/api/progress/:courseId')
    .replace(/\/[0-9]{1,20}(?=\/|$)/g, '/:id')
    .slice(0, 160);
};

const emptyAggregate = () => ({ requests:0, errors:0, unauthorized:0, notFound:0, rateLimited:0 });
const add = (target, value) => {
  target.requests += value.requests;
  target.errors += value.errors;
  target.unauthorized += value.unauthorized;
  target.notFound += value.notFound;
  target.rateLimited += value.rateLimited;
};

export function createRequestMonitor({ retentionMinutes = 60, maximumSources = 512, now = () => Date.now() } = {}) {
  const secret = randomBytes(32);
  const minutes = new Map();
  const sources = new Map();
  const sourceId = (value) => createHash('sha256').update(secret).update(String(value)).digest('hex').slice(0, 12);
  const prune = (currentMinute) => {
    const cutoff = currentMinute - retentionMinutes + 1;
    for (const key of minutes.keys()) if (key < cutoff) minutes.delete(key);
    for (const [id, values] of sources) {
      for (const key of values.keys()) if (key < cutoff) values.delete(key);
      if (!values.size) sources.delete(id);
    }
  };
  const record = ({ method = 'GET', url = '/', status = 200, source = 'unknown' }, time = now()) => {
    const minute = minuteKey(time);
    prune(minute);
    const route = `${method.toUpperCase()} ${routeName(url)}`;
    const value = { requests:1, errors:status >= 500 ? 1 : 0, unauthorized:[401,403].includes(status) ? 1 : 0, notFound:status === 404 ? 1 : 0, rateLimited:status === 429 ? 1 : 0 };
    const bucket = minutes.get(minute) ?? { ...emptyAggregate(), routes:new Map() };
    add(bucket, value);
    bucket.routes.set(route, (bucket.routes.get(route) ?? 0) + 1);
    minutes.set(minute, bucket);
    const id = sourceId(source);
    if (!sources.has(id) && sources.size >= maximumSources) sources.delete(sources.keys().next().value);
    const sourceBuckets = sources.get(id) ?? new Map();
    const sourceBucket = sourceBuckets.get(minute) ?? emptyAggregate();
    add(sourceBucket, value);
    sourceBuckets.set(minute, sourceBucket);
    sources.set(id, sourceBuckets);
  };
  const aggregate = (count, currentMinute) => {
    const result = emptyAggregate();
    const routes = new Map();
    for (let key = currentMinute - count + 1; key <= currentMinute; key += 1) {
      const bucket = minutes.get(key);
      if (!bucket) continue;
      add(result, bucket);
      for (const [route, total] of bucket.routes) routes.set(route, (routes.get(route) ?? 0) + total);
    }
    return { ...result, topRoutes:[...routes].sort((a,b)=>b[1]-a[1]).slice(0,8).map(([route,requests])=>({route,requests})) };
  };
  const snapshot = (time = now()) => {
    const currentMinute = minuteKey(time);
    prune(currentMinute);
    const suspiciousSources = [];
    for (const [id, buckets] of sources) {
      const recent = emptyAggregate();
      for (let key=currentMinute-4; key<=currentMinute; key+=1) if (buckets.has(key)) add(recent,buckets.get(key));
      const indicators = [];
      if (recent.requests >= 300) indicators.push('high-volume');
      if (recent.unauthorized >= 10) indicators.push('authorization-failures');
      if (recent.notFound >= 20) indicators.push('route-scanning');
      if (recent.rateLimited >= 3) indicators.push('rate-limit-rejections');
      if (indicators.length) suspiciousSources.push({ source:id, windowMinutes:5, ...recent, indicators });
    }
    return { generatedAt:new Date(time).toISOString(), retentionMinutes, currentMinute:aggregate(1,currentMinute), last5Minutes:aggregate(5,currentMinute), last60Minutes:aggregate(60,currentMinute), suspiciousSources:suspiciousSources.sort((a,b)=>b.requests-a.requests) };
  };
  const observe = (request, response, source) => {
    const started = now();
    response.once('finish', () => record({ method:request.method, url:request.url, status:response.statusCode, source }, started));
  };
  return { observe, record, snapshot };
}
