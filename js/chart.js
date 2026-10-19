const NS = 'http://www.w3.org/2000/svg';
let seq = 0;

/* Minimal line chart with touch scrubbing (TR-style: line right of the finger dims). */
export function mountChart(host, onScrub) {
  const clipId = `clip${++seq}`;
  const svg = document.createElementNS(NS, 'svg');
  svg.classList.add('chart-svg');
  host.replaceChildren(svg);

  let series = null;
  let geom = null;
  let active = false;

  function draw(s) {
    series = s;
    const w = host.clientWidth;
    const h = host.clientHeight;
    const pts = s.points;
    const [x0, x1] = s.xDomain ?? [pts[0].t, pts[pts.length - 1].t];

    let lo = s.base, hi = s.base;
    for (const p of pts) {
      if (p.v < lo) lo = p.v;
      if (p.v > hi) hi = p.v;
    }
    if (hi - lo < hi * 1e-3) {
      hi *= 1.005;
      lo *= 0.995;
    }

    const padT = 24, padB = 24, padR = 14;
    const X = (t) => (x1 === x0 ? 0 : ((t - x0) / (x1 - x0)) * (w - padR));
    const Y = (v) => padT + ((hi - v) / (hi - lo)) * (h - padT - padB);
    const xs = pts.map((p) => X(p.t));
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${xs[i].toFixed(1)} ${Y(p.v).toFixed(1)}`).join('');
    const lx = xs[xs.length - 1].toFixed(1);
    const ly = Y(pts[pts.length - 1].v).toFixed(1);
    const by = Y(s.base).toFixed(1);

    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    svg.innerHTML = `
      <defs><clipPath id="${clipId}"><rect class="clip" x="0" y="0" width="${w}" height="${h}"/></clipPath></defs>
      <line class="base" x1="0" x2="${w}" y1="${by}" y2="${by}"/>
      <path class="line dim" d="${d}"/>
      <path class="line" d="${d}" clip-path="url(#${clipId})"/>
      <circle class="pulse" cx="${lx}" cy="${ly}" r="4"/>
      <circle class="dot" cx="${lx}" cy="${ly}" r="4"/>
      <g class="scrub" visibility="hidden">
        <line class="scrub-line" x1="0" x2="0" y1="0" y2="${h}"/>
        <circle class="scrub-dot" r="5"/>
      </g>`;
    geom = { xs, Y, w };
  }

  function nearest(x) {
    const { xs } = geom;
    let lo = 0, hi = xs.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] < x) lo = mid;
      else hi = mid;
    }
    return Math.abs(xs[lo] - x) <= Math.abs(xs[hi] - x) ? lo : hi;
  }

  function move(e) {
    if (!series) return;
    const x = e.clientX - svg.getBoundingClientRect().left;
    const i = nearest(x);
    const p = series.points[i];
    const px = geom.xs[i];
    const g = svg.querySelector('.scrub');
    g.setAttribute('visibility', 'visible');
    g.querySelector('line').setAttribute('x1', px);
    g.querySelector('line').setAttribute('x2', px);
    g.querySelector('circle').setAttribute('cx', px);
    g.querySelector('circle').setAttribute('cy', geom.Y(p.v));
    svg.querySelector('.clip').setAttribute('width', px);
    svg.classList.add('scrubbing');
    onScrub(p);
  }

  function end() {
    if (!active) return;
    active = false;
    svg.querySelector('.scrub')?.setAttribute('visibility', 'hidden');
    svg.querySelector('.clip')?.setAttribute('width', geom.w);
    svg.classList.remove('scrubbing');
    onScrub(null);
  }

  svg.addEventListener('pointerdown', (e) => {
    active = true;
    try { svg.setPointerCapture(e.pointerId); } catch { /* not supported */ }
    move(e);
  });
  svg.addEventListener('pointermove', (e) => active && move(e));
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => svg.addEventListener(ev, end));

  return { draw, redraw: () => series && draw(series) };
}
