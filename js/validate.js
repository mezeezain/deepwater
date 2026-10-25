// Small pure validators shared by the UI and the tests.

/** A whale/catcher server address must be https, or http on this machine. Returns the cleaned URL or null. */
export function cleanServerUrl(input) {
  let u;
  try {
    u = new URL(String(input || '').trim());
  } catch {
    return null;
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  if (u.username || u.password) return null;
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

/** Parse a decimal the user typed ("1,5", " 2 ", "1e3"). Returns a finite number or NaN. */
export function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  const s = String(v ?? '').trim().replace(/,/g, '.');
  if (!s || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return NaN;
  return Number(s);
}
