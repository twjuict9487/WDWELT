export const TAIPEI_OFFSET = '+08:00';

export function toTaipeiIsoString(value = new Date()) {
  let instant;
  if (value instanceof Date) instant = value;
  else {
    const text = String(value).trim();
    const normalized = text.includes('T') ? text : text.replace(' ', 'T');
    instant = new Date(/(?:Z|[+-]\d\d:\d\d)$/i.test(normalized) ? normalized : `${normalized}${TAIPEI_OFFSET}`);
  }
  if (Number.isNaN(instant.getTime())) throw new Error('Invalid timestamp');
  return new Date(instant.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('Z', TAIPEI_OFFSET);
}

export function formatTaipeiDateTime(value = new Date()) {
  return toTaipeiIsoString(value).replace('T', ' ').replace(/\.\d{3}\+08:00$/, ' +08:00');
}
