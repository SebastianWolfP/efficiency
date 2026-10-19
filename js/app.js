import * as store from './store.js';
import { simulate, buildSeries, computeStats, headline, RANGES, RANGE_LABEL } from './sim.js';
import { mountChart } from './chart.js';
import {
  esc, fmtEUR, fmtPct, fmtSignedPct, fmtWhen, fmtDateLong, fmtDateShort,
  dateKey, addDays, isDateKey, scoreLabel, firstGrapheme, makeTicker,
} from './util.js';

const view = document.getElementById('view');
const rangeFor = { home: '1T', detail: '1T' };
const simCache = new Map();
let charts = [];

const ICON = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  fwd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>',
  sort: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4"/></svg>',
};

function simOf(stock) {
  let s = simCache.get(stock.id);
  if (!s) {
    s = simulate(stock, store.entries(stock.id), new Date(), store.settings().missingScore);
    simCache.set(stock.id, s);
  }
  return s;
}

/* ---------- routing ---------- */
function route(scrollTop = true) {
  simCache.clear();
  charts = [];
  const [page = '', arg] = location.hash.replace(/^#\/?/, '').split('/');
  const tab = page === 'checkin' || page === 'settings' ? page : 'home';
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));

  if (page === 'stock') renderDetail(decodeURIComponent(arg ?? ''));
  else if (page === 'checkin') renderCheckin(arg);
  else if (page === 'settings') renderSettings();
  else renderHome();

  if (scrollTop) window.scrollTo(0, 0);
}

window.addEventListener('hashchange', () => route());
document.addEventListener('visibilitychange', () => {
  const editing = document.querySelector('.sheet-backdrop') || location.hash.startsWith('#/checkin');
  if (document.visibilityState === 'visible' && !editing) route(false);
});
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => charts.forEach((c) => c.redraw()), 120);
});

/* ---------- shared pieces ---------- */
const avatar = (s, cls = '') => `<div class="avatar ${cls}">${esc(s.emoji || s.name.slice(0, 1))}</div>`;

function changeHtml(abs, pct, label) {
  const up = abs >= -0.005;
  return `<span class="${up ? 'pos' : 'neg'}">${up ? '▲' : '▼'} ${fmtEUR(Math.abs(abs))} (${fmtPct(Math.abs(pct))})</span><span class="muted"> ${esc(label)}</span>`;
}

const priceBlockHtml = () => `
  <section class="price-block">
    <div class="price-big" data-price></div>
    <div class="change" data-change></div>
    <div class="chart" data-chart></div>
    <div class="ranges">${RANGES.map((r) => `<button class="range" data-range="${r}">${r}</button>`).join('')}</div>
  </section>`;

function setupPriceBlock(el, stock, key, onRange) {
  const sim = simOf(stock);
  const priceEl = el.querySelector('[data-price]');
  const changeEl = el.querySelector('[data-change]');
  let series;

  const show = (p, label) => {
    priceEl.textContent = fmtEUR(p.v);
    changeEl.innerHTML = changeHtml(p.v - series.base, p.v / series.base - 1, label);
  };

  const chart = mountChart(el.querySelector('[data-chart]'), (p) => {
    const r = rangeFor[key];
    if (p) show(p, fmtWhen(p.t, r));
    else show(series.points[series.points.length - 1], RANGE_LABEL[r]);
  });
  charts.push(chart);

  const setRange = (r) => {
    rangeFor[key] = r;
    series = buildSeries(stock.id, sim, r);
    chart.draw(series);
    el.querySelectorAll('.range').forEach((b) => b.classList.toggle('active', b.dataset.range === r));
    show(series.points[series.points.length - 1], RANGE_LABEL[r]);
    onRange?.(r);
  };
  el.querySelectorAll('.range').forEach((b) => { b.onclick = () => setRange(b.dataset.range); });
  setRange(rangeFor[key]);
}

const SORTS = {
  manual: { label: 'Reihenfolge beim Anlegen', fn: null },
  name: { label: 'Name A–Z', fn: (a, b) => a.stock.name.localeCompare(b.stock.name, 'de') },
  perfDesc: { label: 'Top-Gewinner', fn: (a, b) => b.change - a.change },
  perfAsc: { label: 'Top-Verlierer', fn: (a, b) => a.change - b.change },
  priceDesc: { label: 'Kurs: höchster zuerst', fn: (a, b) => b.price - a.price },
  priceAsc: { label: 'Kurs: niedrigster zuerst', fn: (a, b) => a.price - b.price },
  scoreDesc: { label: 'Score heute: höchster zuerst', fn: (a, b) => (b.score ?? -1) - (a.score ?? -1) },
};
const currentSort = () => (SORTS[store.settings().habitSort] ? store.settings().habitSort : 'manual');

function habitItem(stock, range) {
  const series = buildSeries(stock.id, simOf(stock), range);
  const price = series.points[series.points.length - 1].v;
  return { stock, price, change: price / series.base - 1, score: store.score(stock.id, dateKey()) };
}

function rowHtml({ stock, price, change, score }) {
  return `
    <a class="row" href="#/stock/${encodeURIComponent(stock.id)}">
      ${avatar(stock)}
      <div class="row-main">
        <div class="row-title">${esc(stock.name)}</div>
        <div class="row-sub">${esc(stock.ticker)} · ${score == null ? '<span class="open-dot"></span>offen' : `Score ${score}`}</div>
      </div>
      <div class="row-right">
        <div class="row-price">${fmtEUR(price)}</div>
        <div class="row-change ${change >= 0 ? 'pos' : 'neg'}">${change >= 0 ? '▲' : '▼'} ${fmtPct(Math.abs(change))}</div>
      </div>
    </a>`;
}

function openSortSheet(onPick) {
  const cur = currentSort();
  const sheet = openSheet(`
    <h2 class="sheet-title">Sortieren</h2>
    <div class="group">${Object.entries(SORTS).map(([k, s]) => `
      <button class="group-row" data-key="${k}"><span>${s.label}</span>${k === cur ? '<span class="tick">✓</span>' : ''}</button>`).join('')}
    </div>`);
  sheet.querySelectorAll('[data-key]').forEach((b) => {
    b.onclick = () => {
      store.updateSettings({ habitSort: b.dataset.key });
      closeSheet();
      onPick();
    };
  });
}

function scoreCardHtml(stock, value, { hint, clearable } = {}) {
  const v = value ?? 50;
  return `
    <div class="score-card ${value == null ? 'unset' : ''}" data-id="${esc(stock.id)}">
      <div class="score-head">
        ${avatar(stock)}
        <div class="row-main">
          <div class="row-title">${esc(stock.name)}</div>
          <div class="score-label">${value == null ? 'Noch nicht bewertet' : scoreLabel(value)}</div>
        </div>
        <div class="score-val">${value ?? '–'}</div>
      </div>
      <input class="slider" type="range" min="0" max="100" step="1" value="${v}" style="--p:${v}%">
      <div class="slider-scale"><span>0</span><span>50</span><span>100</span></div>
      ${hint ? `<div class="hint">${esc(hint)}</div>` : ''}
      ${clearable && value != null ? '<button class="link-btn" data-clear>Bewertung entfernen</button>' : ''}
    </div>`;
}

function wireScoreCard(card, onChange) {
  const input = card.querySelector('.slider');
  const valEl = card.querySelector('.score-val');
  const label = card.querySelector('.score-label');
  const commit = () => {
    const v = Number(input.value);
    card.classList.remove('unset');
    input.style.setProperty('--p', `${v}%`);
    valEl.textContent = v;
    label.textContent = scoreLabel(v);
    onChange(v);
  };
  input.addEventListener('input', commit);
  // A tap on an untouched slider should also count (value 50 without moving).
  input.addEventListener('pointerup', () => card.classList.contains('unset') && commit());
  card.querySelector('[data-clear]')?.addEventListener('click', () => {
    card.classList.add('unset');
    valEl.textContent = '–';
    label.textContent = 'Wird beim Speichern entfernt';
    onChange(null);
  });
}

/* ---------- pages ---------- */
function renderHome() {
  const { stocks } = store.get();
  const index = stocks.find((s) => s.type === 'index');
  const habits = stocks.filter((s) => s.type !== 'index');
  const today = dateKey();
  const open = stocks.filter((s) => store.score(s.id, today) == null).length;

  view.innerHTML = `
    <a class="home-head" href="#/stock/${encodeURIComponent(index.id)}">
      <span class="eyebrow">${esc(index.emoji)} ${esc(index.name)}</span>${ICON.chev}
    </a>
    ${priceBlockHtml()}
    <a class="cta ${open ? '' : 'done'}" href="#/checkin">
      <div>
        <div class="cta-title">${open ? 'Tagesabschluss' : 'Alles bewertet'}</div>
        <div class="cta-sub">${open ? `${open} ${open === 1 ? 'Wert wartet' : 'Werte warten'} auf deine Bewertung` : 'Bis morgen. Der Markt arbeitet für dich.'}</div>
      </div>
      ${open ? `<span class="badge">${open}</span>` : '<span class="check">✓</span>'}
    </a>
    <div class="section-head">
      <h2 class="section-title">Habits</h2>
      ${habits.length > 1 ? `<button class="sort-btn" data-sort>${ICON.sort}<span data-sort-label></span></button>` : ''}
    </div>
    ${habits.length ? '<div class="section-caption" data-caption></div>' : ''}
    <div class="list" data-list>
      ${habits.length ? '' : '<div class="empty">Noch keine Habits. Leg deine erste Aktie an – z. B. Fitness oder Spanisch.</div>'}
    </div>
    <button class="btn secondary add-btn" data-add>+ Neues Habit anlegen</button>`;

  const renderList = () => {
    if (!habits.length) return;
    const range = rangeFor.home;
    const sort = currentSort();
    const items = habits.map((s) => habitItem(s, range));
    if (SORTS[sort].fn) items.sort(SORTS[sort].fn);
    view.querySelector('[data-list]').innerHTML = items.map(rowHtml).join('');
    view.querySelector('[data-caption]').textContent = `Performance: ${RANGE_LABEL[range]}`;
    const label = view.querySelector('[data-sort-label]');
    if (label) label.textContent = SORTS[sort].label;
  };

  setupPriceBlock(view.querySelector('.price-block'), index, 'home', renderList);
  view.querySelector('[data-sort]')?.addEventListener('click', () => openSortSheet(renderList));
  view.querySelector('[data-add]').onclick = () => openStockSheet();
}

function renderDetail(id) {
  const stock = store.stock(id);
  if (!stock) {
    location.replace('#/');
    return;
  }
  const sim = simOf(stock);
  const entries = store.entries(id);
  const today = dateKey();
  const st = computeStats(sim, entries, today);
  const isIndex = stock.type === 'index';
  const history = sim.days.filter((d) => d.score != null).slice(-30).reverse();
  const events = sim.events.slice(-8).reverse();
  const stat = (label, value) => `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div></div>`;

  view.innerHTML = `
    <div class="topbar">
      <a class="icon-btn" href="#/" aria-label="Zurück">${ICON.back}</a>
      <span class="topbar-title">${esc(stock.ticker)}</span>
      <button class="icon-btn" data-edit aria-label="Bearbeiten">${ICON.more}</button>
    </div>
    <div class="detail-head">
      <div>
        <h1 class="detail-name">${esc(stock.name)}</h1>
        <div class="muted small">${esc(stock.ticker)} · ${isIndex ? 'Index' : 'Habit'}</div>
      </div>
      ${avatar(stock, 'lg')}
    </div>
    ${priceBlockHtml()}

    <h2 class="section-title">Kennzahlen</h2>
    <div class="stats">
      ${stat('Seit IPO', `<span class="${st.sinceIpo >= 0 ? 'pos' : 'neg'}">${fmtSignedPct(st.sinceIpo)}</span>`)}
      ${stat('IPO', `${fmtEUR(st.ipoPrice)}<small>${fmtDateShort(st.ipoDate)}</small>`)}
      ${stat('Hoch 52W', fmtEUR(st.high))}
      ${stat('Tief 52W', fmtEUR(st.low))}
      ${stat('Ø Score 30T', st.avg30 == null ? '–' : Math.round(st.avg30))}
      ${stat('Volatilität 30T', st.vol == null ? '–' : fmtPct(st.vol))}
      ${stat('Serie ≥ 70', `${st.streak} ${st.streak === 1 ? 'Tag' : 'Tage'}`)}
      ${stat('Bewertungen', st.count)}
    </div>

    <h2 class="section-title">Ereignisse</h2>
    ${events.length ? `<div class="list">${events.map((e) => `
      <div class="event">
        <div class="event-icon ${e.type === 'crash' ? 'neg' : e.type === 'rally' ? 'pos' : ''}">${e.type === 'split' ? '÷' : e.type === 'crash' ? '▼' : '▲'}</div>
        <div class="row-main">
          <div class="event-title">${esc(headline(stock, e))}</div>
          <div class="row-sub">${fmtDateShort(e.date)} · ${e.type === 'split' ? `Split ${e.ratio}:1` : `<span class="${e.pct >= 0 ? 'pos' : 'neg'}">${fmtSignedPct(e.pct)}</span>`}</div>
        </div>
      </div>`).join('')}</div>` : '<div class="empty">Noch keine besonderen Kursereignisse.</div>'}

    <h2 class="section-title">Verlauf</h2>
    ${history.length ? `<div class="list">${history.map((d) => {
      const ch = d.close / d.open - 1;
      return `
        <a class="hist" href="#/checkin/${d.date}">
          <div class="hist-date">${fmtDateShort(d.date)}</div>
          <div class="hist-bar"><span style="width:${d.score}%"></span></div>
          <div class="hist-score">${d.score}</div>
          <div class="hist-ch ${ch >= 0 ? 'pos' : 'neg'}">${fmtSignedPct(ch)}</div>
        </a>`;
    }).join('')}</div>` : '<div class="empty">Noch keine Bewertungen.</div>'}`;

  setupPriceBlock(view.querySelector('.price-block'), stock, 'detail');
  view.querySelector('[data-edit]').onclick = () => openStockSheet(stock);
}

function renderCheckin(arg) {
  const today = dateKey();
  const date = isDateKey(arg) && arg <= today ? arg : today;
  const { stocks } = store.get();
  const list = [...stocks.filter((s) => s.type === 'index'), ...stocks.filter((s) => s.type !== 'index')]
    .filter((s) => s.createdAt <= date);
  const draft = new Map();

  view.innerHTML = `
    <div class="checkin-head">
      <a class="icon-btn" href="#/checkin/${addDays(date, -1)}" aria-label="Vortag">${ICON.back}</a>
      <div class="checkin-title">
        <div class="eyebrow">Tagesabschluss</div>
        <div class="title">${date === today ? 'Heute' : esc(fmtDateLong(date))}</div>
      </div>
      ${date < today ? `<a class="icon-btn" href="#/checkin/${addDays(date, 1)}" aria-label="Folgetag">${ICON.fwd}</a>` : '<span class="icon-btn"></span>'}
    </div>
    <p class="muted intro">Wie gut lief es? 0 = gar nicht, 100 = perfekt. Der Kurs reagiert darauf – aber nicht 1:1.</p>
    ${list.length
      ? list.map((s) => scoreCardHtml(s, store.score(s.id, date), {
        hint: s.type === 'index' ? 'Dein Gesamtgefühl – unabhängig von den einzelnen Habits.' : null,
        clearable: true,
      })).join('')
      : '<div class="empty">An diesem Tag gab es noch keine Werte.</div>'}
    <div class="save-bar"><button class="btn" data-save disabled>Speichern</button></div>`;

  const saveBtn = view.querySelector('[data-save]');
  view.querySelectorAll('.score-card').forEach((card) => wireScoreCard(card, (v) => {
    draft.set(card.dataset.id, v);
    saveBtn.disabled = false;
  }));
  saveBtn.onclick = () => {
    draft.forEach((v, id) => store.setScore(id, date, v));
    toast('Tagesabschluss gespeichert');
    location.hash = '#/';
  };
}

function renderSettings() {
  const { missingScore } = store.settings();
  view.innerHTML = `
    <h1 class="page-title">Profil</h1>
    <div class="group">
      <label class="group-row">
        <span>Fehlender Tag zählt als</span>
        <select data-missing>${[0, 20, 30, 40, 50].map((v) => `<option value="${v}" ${v === missingScore ? 'selected' : ''}>Score ${v}</option>`).join('')}</select>
      </label>
    </div>
    <p class="muted small pad">Vergangene Tage ohne Bewertung fließen mit diesem Score in die Kursberechnung ein.</p>

    <h2 class="section-title">Daten</h2>
    <div class="group">
      <button class="group-row" data-export><span>Backup exportieren</span>${ICON.chev}</button>
      <button class="group-row" data-import><span>Backup importieren</span>${ICON.chev}</button>
      <button class="group-row" data-demo><span>Beispieldaten laden</span>${ICON.chev}</button>
      <button class="group-row danger" data-reset><span>Alle Daten löschen</span></button>
    </div>
    <input type="file" accept="application/json,.json" hidden data-file>
    <p class="muted small pad">Alle Daten liegen ausschließlich lokal auf diesem iPhone. Exportiere ab und zu ein Backup (z. B. in die Dateien-App).</p>

    <h2 class="section-title">So entsteht der Kurs</h2>
    <div class="explain">
      <p><b>Fundamentaldaten.</b> Jeder Score verschiebt den fairen Wert: über 50 wächst er, darunter schrumpft er. Ein dauerhaft hoher Schnitt wirkt zusätzlich.</p>
      <p><b>Stimmung.</b> Der Markt reagiert auf Überraschungen gegenüber deinem Schnitt und auf Momentum – und pendelt danach zum fairen Wert zurück.</p>
      <p><b>Volatilität.</b> Stark schwankende Scores machen die Aktie nervös. Konstanz wird mit ruhigem Kurs und einem kleinen Aufschlag belohnt.</p>
      <p><b>Crashs &amp; Rallys.</b> Mehrere schwache Tage in Folge oder eine überhitzte Bewertung können einen Kurssturz auslösen. Starke Serien oder Unterbewertung führen zu Rallys.</p>
      <p><b>Markt.</b> Eine gemeinsame Marktstimmung bewegt alle Werte leicht mit.</p>
    </div>`;

  view.querySelector('[data-missing]').onchange = (e) => {
    store.updateSettings({ missingScore: Number(e.target.value) });
    toast('Gespeichert');
  };
  view.querySelector('[data-export]').onclick = exportBackup;
  const fileIn = view.querySelector('[data-file]');
  view.querySelector('[data-import]').onclick = () => fileIn.click();
  fileIn.onchange = async () => {
    const file = fileIn.files?.[0];
    if (!file) return;
    try {
      store.importJSON(await file.text());
      toast('Backup importiert');
      location.hash = '#/';
    } catch {
      toast('Datei konnte nicht gelesen werden');
    }
  };
  view.querySelector('[data-demo]').onclick = () => {
    if (!confirm('Beispieldaten laden? Deine aktuellen Daten werden ersetzt.')) return;
    store.loadDemo();
    location.hash = '#/';
  };
  view.querySelector('[data-reset]').onclick = () => {
    if (!confirm('Wirklich alle Aktien und Bewertungen löschen?')) return;
    store.reset();
    location.hash = '#/';
  };
}

async function exportBackup() {
  const name = `habit-republic-${dateKey()}.json`;
  const file = new File([store.exportJSON()], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Habit Republic Backup' }); } catch { /* cancelled */ }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- sheet: create / edit stock ---------- */
function openStockSheet(stock) {
  const isNew = !stock;
  const s = stock ?? { name: '', ticker: '', emoji: '', startPrice: 100, createdAt: dateKey(), type: 'habit' };
  const sheet = openSheet(`
    <h2 class="sheet-title">${isNew ? 'Neues Habit' : 'Bearbeiten'}</h2>
    <form>
      <div class="field"><label>Name</label><input name="name" required maxlength="40" value="${esc(s.name)}" placeholder="z. B. Fitness" autocomplete="off"></div>
      <div class="field-row">
        <div class="field"><label>Kürzel</label><input name="ticker" maxlength="5" value="${esc(s.ticker)}" placeholder="FIT" autocapitalize="characters" autocomplete="off"></div>
        <div class="field"><label>Emoji</label><input name="emoji" value="${esc(s.emoji)}" placeholder="💪" autocomplete="off"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Startkurs (€)</label><input name="startPrice" type="number" inputmode="decimal" min="1" step="0.01" value="${s.startPrice}"></div>
        <div class="field"><label>IPO-Datum</label><input name="createdAt" type="date" max="${dateKey()}" value="${s.createdAt}"></div>
      </div>
      <p class="muted small">Startkurs und IPO-Datum bestimmen den gesamten Kursverlauf. Mit einem früheren Datum kannst du alte Werte nachtragen.</p>
      <button class="btn" type="submit">${isNew ? 'Aktie anlegen' : 'Speichern'}</button>
      ${!isNew && s.type !== 'index' ? '<button class="btn danger" type="button" data-delete>Habit löschen</button>' : ''}
    </form>
    ${isNew ? '' : splitBoxHtml(stock)}`);

  const form = sheet.querySelector('form');
  const f = form.elements;
  let tickerTouched = !isNew;
  f.ticker.addEventListener('input', () => { tickerTouched = true; });
  f.name.addEventListener('input', () => {
    if (!tickerTouched) f.ticker.value = makeTicker(f.name.value);
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = f.name.value.trim();
    if (!name) return;
    const price = Number(String(f.startPrice.value).replace(',', '.'));
    const created = f.createdAt.value;
    const data = {
      name,
      ticker: (f.ticker.value.trim() || makeTicker(name) || 'HBT').toUpperCase().slice(0, 5),
      emoji: firstGrapheme(f.emoji.value.trim()),
      startPrice: price > 0 && price < 1e9 ? price : 100,
      createdAt: isDateKey(created) && created <= dateKey() ? created : dateKey(),
    };
    closeSheet();
    if (isNew) {
      location.hash = `#/stock/${encodeURIComponent(store.addStock(data).id)}`;
    } else {
      store.updateStock(stock.id, data);
      route(false);
    }
  });

  form.querySelector('[data-delete]')?.addEventListener('click', () => {
    if (!confirm(`„${stock.name}“ und alle Bewertungen löschen?`)) return;
    store.deleteStock(stock.id);
    closeSheet();
    location.hash = '#/';
  });

  if (!isNew) wireSplitBox(sheet, stock);
}

const SPLIT_RATIOS = [2, 3, 4, 5, 10];

function splitBoxHtml(stock) {
  const price = simOf(stock).days.at(-1).close;
  const splits = stock.splits ?? [];
  return `
    <section class="split-box">
      <h3 class="split-title">Aktiensplit</h3>
      <p class="muted small">Teilt den Kurs und passt die gesamte Historie an – die prozentuale Entwicklung bleibt identisch. Aktuell ${fmtEUR(price)}.</p>
      <div class="field-row">
        <div class="field"><select data-ratio>${SPLIT_RATIOS.map((r) => `<option value="${r}">${r}:1 → ${fmtEUR(price / r)}</option>`).join('')}</select></div>
        <button class="btn secondary split-btn" type="button" data-split>Splitten</button>
      </div>
      ${splits.length ? `<div class="split-list">${splits.map((sp, i) => `
        <div class="split-item">
          <span>${sp.ratio}:1 · <span class="muted">${fmtDateShort(sp.date)}</span></span>
          <button class="link-btn" type="button" data-unsplit="${i}">Rückgängig</button>
        </div>`).join('')}</div>` : ''}
    </section>`;
}

function wireSplitBox(sheet, stock) {
  const ratioSel = sheet.querySelector('[data-ratio]');
  sheet.querySelector('[data-split]').addEventListener('click', () => {
    const ratio = Number(ratioSel.value);
    if (!SPLIT_RATIOS.includes(ratio)) return;
    const price = simOf(stock).days.at(-1).close;
    if (!confirm(`Split ${ratio}:1 durchführen?\n${fmtEUR(price)} → ${fmtEUR(price / ratio)}`)) return;
    store.addSplit(stock.id, ratio);
    closeSheet();
    toast(`Split ${ratio}:1 durchgeführt`);
    route(false);
  });
  sheet.querySelectorAll('[data-unsplit]').forEach((b) => b.addEventListener('click', () => {
    if (!confirm('Diesen Split rückgängig machen?')) return;
    store.removeSplit(stock.id, Number(b.dataset.unsplit));
    closeSheet();
    toast('Split rückgängig gemacht');
    route(false);
  }));
}

function openSheet(html) {
  closeSheet();
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.innerHTML = `<div class="sheet"><div class="grabber"></div>${html}</div>`;
  backdrop.addEventListener('click', (e) => e.target === backdrop && closeSheet());
  document.body.appendChild(backdrop);
  document.body.classList.add('no-scroll');
  return backdrop.querySelector('.sheet');
}

function closeSheet() {
  document.querySelector('.sheet-backdrop')?.remove();
  document.body.classList.remove('no-scroll');
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

/* ---------- boot ---------- */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
navigator.storage?.persist?.();
route();
