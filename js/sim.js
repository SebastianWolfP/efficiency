import { rng, gauss, std, addDays, dateKey, parseKey } from './util.js';

export const RANGES = ['1T', '1W', '1M', '6M', '1J', 'Max'];
export const RANGE_LABEL = { '1T': 'Heute', '1W': '1 Woche', '1M': '1 Monat', '6M': '6 Monate', '1J': '1 Jahr', Max: 'Seit IPO' };
const SPAN_DAYS = { '1W': 7, '1M': 30, '6M': 182, '1J': 365, Max: Infinity };

const SLOTS = 96; // 15-minute ticks per day
const SLOT_MS = 15 * 60 * 1000;

/* Shared market mood (AR-like, deterministic per date) moves all stocks a little. */
const moodCache = new Map();
function marketMood(date) {
  let m = moodCache.get(date);
  if (m === undefined) {
    m = 0;
    let w = 1;
    let d = date;
    for (let k = 0; k < 20; k++) {
      m += w * gauss(rng('market', d));
      w *= 0.85;
      d = addDays(d, -1);
    }
    m *= 0.005;
    moodCache.set(date, m);
  }
  return m;
}

/*
 * Price model (log space):  log P = fundamentals + sentiment + market
 *  - fundamentals grow with score (>50 up, <50 down) plus long-term trend & consistency premium
 *  - sentiment mean-reverts, reacts to surprises vs. own average and momentum, noisier when erratic
 *  - crashes: bad streaks or overheated sentiment; rallies: good streaks or undervaluation
 * Randomness is seeded per stock+date, so history stays stable across launches.
 */
export function simulate(stock, entries, now = new Date(), missingScore = 40) {
  const today = dateKey(now);
  const start = stock.createdAt > today ? today : stock.createdAt;
  const ipoDate = addDays(start, -1);
  const mood0 = marketMood(ipoDate);
  // The model is scale-invariant, so a split simply rescales the whole history.
  const splits = stock.splits ?? [];
  const startPrice = stock.startPrice / splits.reduce((f, s) => f * s.ratio, 1);
  const days = [{ date: ipoDate, open: startPrice, close: startPrice, score: null, ipo: true }];
  const events = [];

  let logF = Math.log(startPrice);
  let d = 0, emaS = 0, emaL = 0, bad = 0, good = 0;
  const win = [];

  for (let date = start; date <= today; date = addDays(date, 1)) {
    const open = days[days.length - 1].close;
    const raw = entries[date];

    if (date === today && raw == null) {
      const path = intradayPath(stock.id, date, open, null, now);
      days.push({ date, open, close: path[path.length - 1].v, score: null, pending: true, path });
      break;
    }

    const score = raw ?? missingScore;
    const z = (score - 50) / 50;
    const r = rng(stock.id, date);

    const surprise = z - emaL;
    emaS = emaS * 0.6 + z * 0.4;
    emaL = emaL * 0.93 + z * 0.07;
    win.push(z);
    if (win.length > 10) win.shift();
    const disp = std(win);
    bad = score < 40 ? bad + 1 : 0;
    good = score >= 70 ? good + 1 : 0;

    logF += 0.006 * z + 0.003 * emaL + 0.002 * Math.max(0, emaL) * Math.max(0, 1 - disp * 2);

    const vol = 0.007 + 0.02 * disp + 0.008 * Math.max(0, -emaS);
    d = d * 0.88 + 0.012 * surprise + 0.03 * (emaS - emaL) + vol * gauss(r);

    let event = null;
    const u = r();
    const pCrash = Math.min(0.35, 0.004 + Math.max(0, d - 0.05) * 1.5 + (bad >= 3 ? 0.05 * (bad - 2) : 0));
    const pRally = Math.min(0.3, 0.004 + Math.max(0, -d - 0.05) * 1.5 + (good >= 4 ? 0.035 * (good - 3) : 0));
    if (u < pCrash) {
      d -= 0.06 + r() * 0.16;
      event = { type: 'crash', cause: bad >= 3 ? 'streak' : 'bubble' };
    } else if (u > 1 - pRally) {
      d += 0.04 + r() * 0.1;
      event = { type: 'rally', cause: good >= 4 ? 'streak' : 'rebound' };
    }

    const close = Math.exp(logF + d + marketMood(date) - mood0);
    days.push({ date, open, close, score: raw ?? null });
    if (event) {
      const pct = close / open - 1;
      if ((event.type === 'crash') === (pct < 0)) events.push({ ...event, date, pct });
    }
  }
  for (const s of splits) events.push({ type: 'split', date: s.date, ratio: s.ratio });
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { days, events };
}

/* Intraday ticks: Brownian bridge open→close, or a live random walk while today is unrated. */
export function intradayPath(id, date, open, close, now = new Date()) {
  const start = parseKey(date);
  start.setHours(0, 0, 0, 0);
  const t0 = start.getTime();
  const n = date === dateKey(now) ? Math.min(SLOTS, Math.max(1, Math.floor((now - t0) / SLOT_MS))) : SLOTS;
  const r = rng(id, date, 'intra');
  const inc = Array.from({ length: SLOTS }, () => gauss(r));
  const lo = Math.log(open);
  const pts = [{ t: t0, v: open }];

  if (close == null) {
    let x = lo;
    for (let i = 1; i <= n; i++) {
      x += 0.0008 * inc[i - 1] - 0.03 * (x - lo);
      pts.push({ t: t0 + i * SLOT_MS, v: Math.exp(x) });
    }
  } else {
    const lc = Math.log(close);
    const s = 0.0011 * Math.min(1.6, 0.6 + Math.abs(lc - lo) * 25);
    const W = [0];
    for (let i = 1; i <= n; i++) W.push(W[i - 1] + inc[i - 1]);
    for (let i = 1; i <= n; i++) {
      const f = i / n;
      pts.push({ t: t0 + i * SLOT_MS, v: Math.exp(lo + f * (lc - lo) + s * (W[i] - f * W[n])) });
    }
  }
  return pts;
}

export function buildSeries(id, sim, range, now = new Date()) {
  const { days } = sim;
  const last = days.length - 1;
  const pathOf = (day) => day.path ?? intradayPath(id, day.date, day.open, day.close, now);

  if (range === '1T') {
    const day = days[last];
    const points = pathOf(day);
    const t0 = points[0].t;
    return { points, base: day.open, xDomain: [t0, t0 + SLOTS * SLOT_MS] };
  }

  const from = Math.max(1, last - SPAN_DAYS[range] + 1);
  const count = last - from + 1;
  let points = [];
  if (count <= 45) {
    const step = count <= 10 ? 4 : 24;
    for (let i = from; i <= last; i++) {
      const path = pathOf(days[i]);
      path.forEach((p, j) => {
        if (j === 0 && points.length) return;
        if (j % step === 0 || j === path.length - 1) points.push(p);
      });
    }
  } else {
    const today = dateKey(now);
    const t = (d) => (d.date === today ? now.getTime() : parseKey(d.date).getTime() + 10 * 3600e3);
    points = days.slice(from - 1).map((d) => ({ t: t(d), v: d.close }));
  }
  return { points, base: points[0].v };
}

export function computeStats(sim, entries, today = dateKey()) {
  const { days } = sim;
  const current = days[days.length - 1].close;
  const yearAgo = addDays(today, -365);
  const yr = days.filter((d) => d.date >= yearAgo).map((d) => d.close);

  const monthAgo = addDays(today, -30);
  const scores30 = Object.entries(entries).filter(([d]) => d > monthAgo).map(([, v]) => v);

  const rets = [];
  for (let i = Math.max(1, days.length - 30); i < days.length; i++) {
    if (!days[i].pending) rets.push(Math.log(days[i].close / days[i - 1].close));
  }

  let streak = 0;
  let d = entries[today] == null ? addDays(today, -1) : today;
  while (entries[d] != null && entries[d] >= 70) {
    streak++;
    d = addDays(d, -1);
  }

  return {
    high: Math.max(...yr),
    low: Math.min(...yr),
    avg30: scores30.length ? scores30.reduce((a, b) => a + b, 0) / scores30.length : null,
    vol: rets.length > 2 ? std(rets) * Math.sqrt(365) : null,
    streak,
    sinceIpo: current / days[0].close - 1,
    ipoPrice: days[0].close,
    ipoDate: days[0].date,
    count: Object.keys(entries).length,
  };
}

const HEADLINES = {
  'crash/streak': [
    '{n}: Anleger verlieren nach schwacher Serie die Geduld',
    'Ausverkauf bei {n} – die Disziplin bröckelt',
    '{n} bricht ein: mehrere schwache Tage in Folge',
  ],
  'crash/bubble': [
    'Gewinnmitnahmen: {n} korrigiert kräftig',
    'Überhitzt? {n} rutscht deutlich ab',
    'Blase geplatzt – {n} unter Druck',
  ],
  'rally/streak': [
    '{n} haussiert dank starker Serie',
    'Analysten begeistert: {n} liefert ab',
    'Kaufrausch bei {n} – das Momentum hält',
  ],
  'rally/rebound': [
    'Comeback: {n} erholt sich kräftig',
    'Schnäppchenjäger greifen bei {n} zu',
    'Überraschende Erholung bei {n}',
  ],
};

export function headline(stock, ev) {
  if (ev.type === 'split') return `Aktiensplit ${ev.ratio}:1 – ${stock.name} wird optisch günstiger`;
  const list = HEADLINES[`${ev.type}/${ev.cause}`];
  return list[Math.floor(rng(stock.id, ev.date, 'news')() * list.length)].replace('{n}', stock.name);
}
