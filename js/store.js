import { dateKey, addDays, isDateKey, uid, rng, gauss } from './util.js';

const KEY = 'habit-republic/v1';
const ID_RE = /^[A-Za-z0-9-]{4,64}$/;

const defaults = () => ({ version: 1, settings: { missingScore: 40 }, stocks: [], entries: {} });
const newIndex = () => ({
  id: uid(), type: 'index', name: 'Life Index', ticker: 'LIFE', emoji: '🌍', startPrice: 100, createdAt: dateKey(),
});

function sanitize(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Ungültige Datei');
  const s = defaults();
  const today = dateKey();

  const ms = Number(raw.settings?.missingScore);
  if (Number.isFinite(ms) && ms >= 0 && ms <= 100) s.settings.missingScore = ms;
  if (typeof raw.settings?.habitSort === 'string' && /^[A-Za-z]{1,20}$/.test(raw.settings.habitSort)) {
    s.settings.habitSort = raw.settings.habitSort;
  }

  const ids = new Set();
  for (const x of Array.isArray(raw.stocks) ? raw.stocks : []) {
    if (!x || typeof x.id !== 'string' || !ID_RE.test(x.id) || ids.has(x.id) || typeof x.name !== 'string') continue;
    ids.add(x.id);
    const price = Number(x.startPrice);
    s.stocks.push({
      id: x.id,
      type: x.type === 'index' ? 'index' : 'habit',
      name: x.name.slice(0, 40) || 'Habit',
      ticker: String(x.ticker ?? '').slice(0, 5),
      emoji: String(x.emoji ?? '').slice(0, 16),
      startPrice: price > 0 && price < 1e9 ? price : 100,
      createdAt: isDateKey(x.createdAt) && x.createdAt <= today ? x.createdAt : today,
      splits: (Array.isArray(x.splits) ? x.splits : [])
        .map((sp) => ({ date: sp?.date, ratio: Number(sp?.ratio) }))
        .filter((sp) => isDateKey(sp.date) && sp.ratio > 1 && sp.ratio <= 1000)
        .slice(0, 50),
    });
  }

  let hasIndex = false;
  for (const st of s.stocks) {
    if (st.type !== 'index') continue;
    if (hasIndex) st.type = 'habit';
    hasIndex = true;
  }
  if (!hasIndex) s.stocks.unshift(newIndex());

  for (const st of s.stocks) {
    const src = raw.entries?.[st.id];
    const out = {};
    if (src && typeof src === 'object') {
      for (const [d, v] of Object.entries(src)) {
        const n = Number(v);
        if (isDateKey(d) && Number.isFinite(n)) out[d] = Math.max(0, Math.min(100, Math.round(n)));
      }
    }
    s.entries[st.id] = out;
  }
  return s;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return sanitize(JSON.parse(raw));
  } catch { /* corrupted storage falls back to a fresh state */ }
  return sanitize(defaults());
}

let state = load();
const persist = () => localStorage.setItem(KEY, JSON.stringify(state));
persist();

export const get = () => state;
export const settings = () => state.settings;
export const stock = (id) => state.stocks.find((s) => s.id === id);
export const entries = (id) => state.entries[id] ?? {};
export const score = (id, date) => state.entries[id]?.[date] ?? null;

export function setScore(id, date, v) {
  const e = (state.entries[id] ??= {});
  if (v == null) delete e[date];
  else e[date] = Math.max(0, Math.min(100, Math.round(v)));
  persist();
}

export function addStock(data) {
  const s = { ...data, id: uid(), type: 'habit', splits: [] };
  state.stocks.push(s);
  state.entries[s.id] = {};
  persist();
  return s;
}

export function updateStock(id, patch) {
  Object.assign(stock(id), patch);
  persist();
}

export function addSplit(id, ratio) {
  const s = stock(id);
  (s.splits ??= []).push({ date: dateKey(), ratio });
  persist();
}

export function removeSplit(id, index) {
  stock(id).splits.splice(index, 1);
  persist();
}

export function deleteStock(id) {
  if (stock(id)?.type === 'index') return;
  state.stocks = state.stocks.filter((s) => s.id !== id);
  delete state.entries[id];
  persist();
}

export function updateSettings(patch) {
  Object.assign(state.settings, patch);
  persist();
}

export const exportJSON = () => JSON.stringify({ app: 'habit-republic', exportedAt: new Date().toISOString(), ...state }, null, 2);

export function importJSON(text) {
  state = sanitize(JSON.parse(text));
  persist();
}

export function reset() {
  state = sanitize(defaults());
  persist();
}

export function loadDemo() {
  const today = dateKey();
  const start = addDays(today, -180);
  const defs = [
    { name: 'Life Index', ticker: 'LIFE', emoji: '🌍', type: 'index', base: 62, swing: 12 },
    { name: 'Fitness', ticker: 'FIT', emoji: '💪', base: 66, swing: 18, lapses: true },
    { name: 'Spanisch', ticker: 'ESP', emoji: '🇪🇸', base: 55, swing: 14 },
    { name: 'Lesen', ticker: 'READ', emoji: '📚', base: 70, swing: 8 },
    { name: 'Schlaf', ticker: 'SLP', emoji: '🌙', base: 60, swing: 22, lapses: true },
  ];
  const s = defaults();
  for (const d of defs) {
    const st = { id: uid(), type: d.type ?? 'habit', name: d.name, ticker: d.ticker, emoji: d.emoji, startPrice: 100, createdAt: start };
    s.stocks.push(st);
    const r = rng('demo', d.ticker);
    const e = {};
    let level = d.base;
    let lapse = 0;
    for (let date = start; date < today; date = addDays(date, 1)) {
      level += gauss(r) * 3 + (d.base - level) * 0.08;
      if (d.lapses && lapse === 0 && r() < 0.025) lapse = 5 + Math.floor(r() * 8);
      if (r() < 0.05) continue;
      const v = lapse > 0 ? 15 + r() * 15 : level + gauss(r) * d.swing;
      if (lapse > 0) lapse--;
      e[date] = Math.max(0, Math.min(100, Math.round(v)));
    }
    s.entries[st.id] = e;
  }
  state = sanitize(s);
  persist();
}
