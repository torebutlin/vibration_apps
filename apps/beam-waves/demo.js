// The four wave types of the Euler–Bernoulli beam (3C6 · S5).
//
// Substituting y = e^{iωt}·e^{λx} into EI·y'''' = −ρA·ÿ gives
// λ⁴ = ω²ρA/EI, so λ = ±k and ±ik with k = (ω²ρA/EI)^{1/4}:
// two REAL exponents — evanescent near-fields that oscillate in place
// while decaying/growing in x — and two IMAGINARY exponents — waves
// travelling right (e^{−ikx}) and left (e^{+ikx}).
//
// Each panel animates Re{ e^{iωt} · shape }, as in S5_beam_waves.ipynb.
// The growing solution e^{+kx} is plotted unnormalised on the same axes,
// so it runs off scale except near x = 0 — deliberately, as in the
// lecture: it can only matter near a boundary.

import { createDemoShell } from '../../shared/js/demo-shell/shell.js';
import { Axes, plotTheme } from '../../shared/js/plot/axes.js';

const N = 500;
const OMEGA = 3; // rad/s — animation rate; spatial physics set by k

const shell = createDemoShell({
  title: 'BEAM WAVE TYPES',
  course: '3C6 · S5',
  subtitle: 'evanescent and travelling solutions',
  about:
    'The beam equation is fourth order in x, so a given frequency has FOUR wave solutions, not two: travelling waves e^{∓ikx} moving right/left, plus evanescent near-fields e^{∓kx} that oscillate in place while decaying with distance. Near-fields matter close to boundaries and drivers; far away only the travelling pair survives. Note the evanescent pair never progresses — every point moves in phase. (e^{+kx} is drawn scaled to ±1 at x = L: it is the near-field of a boundary on the right, the mirror twin of e^{−kx}.)',
});

shell.group('Wave');
const getK = shell.slider({
  label: 'Wavenumber k',
  min: 4, max: 25, step: 1, value: 10,
  fmt: (v) => `${v} /L`,
  tip: 'Sets both the wavelength of the travelling pair (2π/k) and the decay length of the evanescent pair (1/k) — in a beam they are locked together: λ = ±k, ±ik.',
});

shell.finePrint(
  "y = e^{iωt}e^{λx}, λ⁴ = ω²ρA/EI. Part of <a href='../../index.html'>Vibration Apps</a>."
);

const panels = [
  { title: 'e⁻ᵏˣ', shape: (x, k, ph) => Math.exp(-k * x) * Math.cos(ph), evan: true },
  // scaled by e^{-kL} so it reads ±1 at the RIGHT edge: the near-field
  // attached to a boundary on the right, mirror twin of e^{-kx}
  { title: 'e⁺ᵏˣ', shape: (x, k, ph) => Math.exp(k * (x - 1)) * Math.cos(ph), evan: true },
  { title: 'e⁻ⁱᵏˣ', shape: (x, k, ph) => Math.cos(ph - k * x), evan: false },
  { title: 'e⁺ⁱᵏˣ', shape: (x, k, ph) => Math.cos(ph + k * x), evan: false },
];

const axes = panels.map(() => new Axes());

shell.onFrame((t) => {
  const { ctx, width: w, height: h } = shell;
  const th = plotTheme();
  const k = getK();
  const ph = OMEGA * t;
  ctx.clearRect(0, 0, w, h);

  const mL = 54;
  const mR = 12;
  const cw = (w - mL - mR) / 2 - mL / 2;
  const chH = (h - 40) / 2 - 44;

  panels.forEach((p, i) => {
    const col = i % 2;
    const rowI = Math.floor(i / 2);
    const ax = axes[i];
    ax.setRect(mL + col * (cw + mL), 28 + rowI * (chH + 52), cw, chH);
    ax.setX(0, 1, false);
    ax.setY(-1, 1, false);
    ax.draw(ctx, {
      xLabel: rowI === 1 ? 'x / L' : '',
      xFmt: (v) => v.toFixed(1),
      yFmt: (v) => v.toFixed(1),
    });
    const r = ax.rect;

    // panel title
    ctx.font = '600 14px "JetBrains Mono", monospace';
    ctx.fillStyle = p.evan ? th.tracePeak : th.traceMain;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(p.title, r.x + r.w / 2, r.y - 5);

    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    ctx.strokeStyle = p.evan ? th.tracePeak : th.traceMain;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let started = false;
    for (let j = 0; j <= N; j++) {
      const x = j / N;
      const y = p.shape(x, k, ph);
      if (!isFinite(y) || Math.abs(y) > 50) { started = false; continue; }
      const px = ax.xToPx(x);
      const py = ax.yToPx(y);
      if (!started) { ctx.moveTo(px, py); started = true; }
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();
  });
});
