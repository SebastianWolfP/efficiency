/* ---------- deterministic randomness ---------- */
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const rng = (...parts) => mulberry32(hashStr(parts.join('|')));

export function gauss(r) {
  let u = 0;
  while (u === 0) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

export function std(a) {
  if (a.length < 2) return 0;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

/* ---------- dates (local, YYYY-MM-DD) ---------- */
export function dateKey(d = new Date()) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function parseKey(k) {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

export function addDays(k, n) {
  const d = parseKey(k);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}

export const isDateKey = (k) => typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k) && !Number.isNaN(parseKey(k).getTime());

export const uid = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/* ---------- formatting ---------- */
const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const pct = new Intl.NumberFormat('de-DE', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtEUR = (v) => eur.format(v);
export const fmtPct = (v) => pct.format(v);
export const fmtSignedPct = (v) => `${v >= 0 ? '+' : '−'}${pct.format(Math.abs(v))}`;

export const fmtDateLong = (k) => parseKey(k).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
export const fmtDateShort = (k) => parseKey(k).toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' });

export function fmtWhen(t, range) {
  const d = new Date(t);
  if (range === '1T') return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  if (range === '1W' || range === '1M') {
    return d.toLocaleString('de-DE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function scoreLabel(v) {
  if (v >= 90) return 'Überragend';
  if (v >= 75) return 'Stark';
  if (v >= 60) return 'Gut';
  if (v >= 45) return 'Okay';
  if (v >= 30) return 'Schwach';
  return 'Kaum bis gar nicht';
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function firstGrapheme(s) {
  if (!s) return '';
  if (globalThis.Intl?.Segmenter) {
    const first = new Intl.Segmenter('de', { granularity: 'grapheme' }).segment(s)[Symbol.iterator]().next();
    return first.value?.segment ?? '';
  }
  return [...s][0] ?? '';
}

export const makeTicker = (name) =>
  name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 4);
