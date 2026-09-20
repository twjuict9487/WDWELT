export const RESET_SECONDS = 10 * 60;
const cookieName = 'wdwelt_reset';
export function resetCookie(token = '', seconds = 0) {
  return `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/api/auth/recovery; Max-Age=${seconds}`;
}

export function readResetCookie(header) {
  if (typeof header !== 'string') return null;
  const values = header.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${cookieName}=`));
  if (values.length !== 1) return null;
  const value = values[0].slice(cookieName.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
