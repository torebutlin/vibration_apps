// d'Alembert travelling waves on a plucked string (3C6 · S4).
//
// A string fixed at x = 0 and x = L, plucked into a triangle at x = a and
// released from rest. With zero initial velocity the solution is
//   y(x,t) = f(x−ct) + g(x+ct),   f = g = ½·y_ext
// where y_ext is the odd periodic extension (period 2L) of the initial
// shape — oddness about each end enforces y = 0 there, which is how the
// "reflections" arise. The plot shows the two travelling components and
// their mirror images beyond the ends feeding the real string.
//
// Maths checked against S4_Dalembert.ipynb: the notebook's piecewise
// definition on [0, 2L] (rise to Y0 at a, fall through zero at L to −Y0
// at 2L−a, return to 0) IS the odd periodic extension; f = g = ½ y_ext
// satisfies release-from-rest, and oddness gives y(0,t) = y(L,t) = 0.

import { createDemoShell } from '../../shared/js/demo-shell/shell.js';
import { Axes, plotTheme } from '../../shared/js/plot/axes.js';

const L = 1;
const Y0 = 0.1;

const shell = createDemoShell({
  title: "D'ALEMBERT WAVES",
  course: '3C6 · S4',
  subtitle: 'plucked string · travelling waves',
  about:
    "A string plucked into a triangle and released from rest. The motion is two waves, f(x−ct) and g(x+ct), each half the initial shape, travelling in opposite directions. Their mirror images beyond the fixed ends (thin lines) enter the string as the reflections — oddness of the extension is what keeps the ends at zero.",
});

shell.group('String');
const getA = shell.slider({
  label: 'Pluck position',
  min: 0.05, max: 0.95, step: 0.01, value: 0.2,
  fmt: (v) => `${v.toFixed(2)} L`,
  tip: 'Where the string is pulled aside before release.',
});
const getC = shell.slider({
  label: 'Wave speed c',
  min: 0.25, max: 2, step: 0.05, value: 1,
  fmt: (v) => `${v.toFixed(2)}`,
  tip: 'Wave speed √(P/m). The pattern repeats with period 2L/c.',
});

shell.group('Display');
const showParts = shell.toggle({
  label: 'Show f and g',
  value: true,
  tip: 'Second panel with the two travelling components drawn separately.',
});
const showMirror = shell.toggle({
  label: 'Show mirror images',
  value: true,
  tip: 'The periodic extension beyond the fixed ends (thin lines) — the part of each wave about to enter the string as a reflection.',
});

shell.finePrint(
  "y(x,t) = f(x−ct) + g(x+ct) with f = g = ½·y₀ (odd periodic extension). Part of <a href='../../index.html'>Vibration Apps</a>."
);

const tReadout = shell.readout('ct/L');

// odd periodic extension of the triangle, period 2L
function yext(u, a) {
  u = ((u % (2 * L)) + 2 * L) % (2 * L);
  if (u <= a) return (Y0 * u) / a;
  if (u <= 2 * L - a) return (Y0 * (L - u)) / (L - a);
  return (Y0 * (u - 2 * L)) / a;
}

const N = 700;
const axTop = new Axes();
const axBot = new Axes();

function drawPanel(ctx, ax, curves, th, labels) {
  // curves: [{fn(x), color, boldInside}]
  ax.setX(-0.5 * L, 1.5 * L, false);
  ax.setY(-1.3 * Y0, 1.3 * Y0, false);
  ax.draw(ctx, { xLabel: 'x / L', yLabel: 'y', xFmt: (v) => v.toFixed(1), yFmt: (v) => v.toFixed(2) });
  const r = ax.rect;
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();

  // string endpoints
  ctx.strokeStyle = th.frame;
  ctx.setLineDash([4, 4]);
  for (const xe of [0, L]) {
    const px = ax.xToPx(xe);
    ctx.beginPath();
    ctx.moveTo(px, r.y);
    ctx.lineTo(px, r.y + r.h);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  for (const { fn, color, dashOutside } of curves) {
    // outside (mirror) part, thin
    if (showMirror()) {
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.3;
      ctx.lineWidth = 1;
      if (dashOutside) ctx.setLineDash([5, 4]);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i <= N; i++) {
        const x = -0.5 * L + (2 * L * i) / N;
        if (x >= 0 && x <= L) { started = false; continue; }
        const px = ax.xToPx(x);
        const py = ax.yToPx(fn(x));
        if (!started) { ctx.moveTo(px, py); started = true; }
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    // inside part, bold
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const x = (L * i) / N;
      const px = ax.xToPx(x);
      const py = ax.yToPx(fn(x));
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  ctx.restore();

  // legend
  ctx.font = '500 11px "JetBrains Mono", monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  let lx = r.x + 12;
  for (const { color, label } of labels) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(lx, r.y + 12);
    ctx.lineTo(lx + 14, r.y + 12);
    ctx.stroke();
    ctx.fillStyle = th.label;
    ctx.fillText(label, lx + 19, r.y + 12.5);
    lx += 19 + ctx.measureText(label).width + 16;
  }
}

// component colours: g gets a blue that works in both themes
function gColor() {
  return document.documentElement.dataset.theme === 'light' ? '#2563eb' : '#6ea8fe';
}

shell.onFrame((t) => {
  const { ctx, width: w, height: h } = shell;
  const th = plotTheme();
  const a = getA();
  const c = getC();
  const parts = showParts();

  const f = (x) => 0.5 * yext(x - c * t, a);
  const g = (x) => 0.5 * yext(x + c * t, a);
  const sum = (x) => f(x) + g(x);

  ctx.clearRect(0, 0, w, h);
  const mL = 64;
  const mR = 14;
  if (parts) {
    axTop.setRect(mL, 12, w - mL - mR, h / 2 - 40);
    axBot.setRect(mL, h / 2 + 16, w - mL - mR, h / 2 - 62);
    drawPanel(ctx, axTop, [{ fn: sum, color: th.traceMain }], th, [{ color: th.traceMain, label: 'y = f + g' }]);
    drawPanel(
      ctx,
      axBot,
      [
        { fn: f, color: th.tracePeak },
        { fn: g, color: gColor() },
      ],
      th,
      [
        { color: th.tracePeak, label: 'f (x − ct)' },
        { color: gColor(), label: 'g (x + ct)' },
      ]
    );
  } else {
    axTop.setRect(mL, 12, w - mL - mR, h - 58);
    drawPanel(ctx, axTop, [{ fn: sum, color: th.traceMain }], th, [{ color: th.traceMain, label: 'y = f + g' }]);
  }

  tReadout.set(((c * t) / L % 2).toFixed(2));
});
