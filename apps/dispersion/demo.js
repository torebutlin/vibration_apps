// Dispersion: group velocity vs phase velocity (3C6 · S4).
//
// Two views of the same idea:
//
// PACKET — a Gaussian envelope imposed on a carrier cos(ωt − kx). The
// carrier crests move at the phase velocity c = ω/k while the envelope
// moves at the group velocity c_g (for beam-like dispersion ω ∝ k²,
// c_g = dω/dk = 2c): watch crests be born at the back of the packet and
// die at the front. (The envelope shape is imposed, not evolved — a real
// dispersive packet would also spread; this isolates the velocity story.)
//
// BEATING — two close wavenumbers k₁, k₂ with beam dispersion ω = k²/1000.
// Sum-to-product: y = cos(k̄x − ω̄t)·cos(Δk/2·x − Δω/2·t), so the carrier
// moves at c_p = ω̄/k̄ = (ω₁+ω₂)/(k₁+k₂) and the beat envelope at
// c_g = Δω/Δk = (k₁+k₂)/1000 ≈ 2c_p. Markers ride each.
//
// Maths checked against S4_dispersive_waves(.ipynb/_beating.ipynb); the
// wavenumber separation is kept even (in units of 2π/L) so the periodic
// wrap of the markers stays aligned with envelope crests.

import { createDemoShell } from '../../shared/js/demo-shell/shell.js';
import { Axes, plotTheme } from '../../shared/js/plot/axes.js';

const L = 1;
const N = 900;

const shell = createDemoShell({
  title: 'DISPERSION',
  course: '3C6 · S4',
  subtitle: 'group velocity vs phase velocity',
  about:
    'When wave speed depends on wavelength (dispersion), the envelope of a disturbance travels at the group velocity c_g = dω/dk, not the phase velocity c = ω/k of the crests. For bending waves ω ∝ k², so c_g = 2c: crests appear at the back of a packet, run through it, and vanish at the front. The beating view shows the same thing with just two frequency components and markers riding the envelope and a crest.',
});

let mode = 'packet';
const groups = {};

shell.group('View');
shell.seg({
  label: 'Mode',
  options: [
    { value: 'packet', label: 'Packet' },
    { value: 'beating', label: 'Beating' },
  ],
  value: 'packet',
  tip: 'Packet: a pulse-like envelope on one carrier. Beating: two close wavenumbers making a beat pattern — the minimal example of a group.',
  onChange: (v) => {
    mode = v;
    groups.packet.el.hidden = v !== 'packet';
    groups.beating.el.hidden = v !== 'beating';
    shell.resetTime();
  },
});

groups.packet = shell.group('Packet');
const getNwaves = shell.slider({
  label: 'Wavelengths',
  min: 8, max: 40, step: 1, value: 20,
  fmt: (v) => `${v}`,
  tip: 'Carrier wavenumber k = 2πN/L — how many wavelengths fit in the window.',
});
const getWidth = shell.slider({
  label: 'Packet width',
  min: 4, max: 20, step: 1, value: 10,
  fmt: (v) => `1/${v}`,
  tip: 'Narrower packets contain a wider band of wavenumbers.',
});
const getRatio = shell.seg({
  label: 'c_g / c',
  options: [
    { value: 0.5, label: '½' },
    { value: 1, label: '1' },
    { value: 2, label: '2' },
  ],
  value: 2,
  tip: 'Group-to-phase velocity ratio. Non-dispersive media give 1 (envelope and crests move together); bending waves in beams give 2; deep-water gravity waves give ½ (envelope slower than crests).',
});

groups.beating = shell.group('Beating');
const getDn = shell.slider({
  label: 'Δk / 2π',
  min: 2, max: 8, step: 2, value: 2,
  fmt: (v) => `${v}`,
  tip: 'Wavenumber separation of the two components (base 30 cycles across the window). Larger separation = shorter beat envelope.',
});

shell.finePrint(
  "Beam dispersion ω = k²/1000 in the beating view. Part of <a href='../../index.html'>Vibration Apps</a>."
);

const roCp = shell.readout('c');
const roCg = shell.readout('c_g');

const ax = new Axes();

function drawLegend(ctx, th, entries) {
  const r = ax.rect;
  ctx.font = '500 11px "JetBrains Mono", monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  let lx = r.x + 12;
  for (const { color, label } of entries) {
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

function tracePath(ctx, fn) {
  ctx.beginPath();
  for (let i = 0; i <= N; i++) {
    const x = (L * i) / N;
    const px = ax.xToPx(x);
    const py = ax.yToPx(fn(x));
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
}

shell.onFrame((t) => {
  const { ctx, width: w, height: h } = shell;
  const th = plotTheme();
  ctx.clearRect(0, 0, w, h);
  ax.setRect(64, 12, w - 64 - 14, h - 70);
  ax.setX(0, L, false);
  ax.setY(-1.15, 1.15, false);
  ax.draw(ctx, { xLabel: 'x / L', yLabel: 'y', xFmt: (v) => v.toFixed(1), yFmt: (v) => v.toFixed(1) });

  const r = ax.rect;
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();

  if (mode === 'packet') {
    // carrier cos(ωt − kx) moves at c = ω/k; envelope centre moves at cg
    const k = (2 * Math.PI * getNwaves()) / L;
    const omega = 10;
    const c = omega / k;
    const cg = getRatio() * c;
    const W = getWidth();
    const env = (x) => {
      const xc = (((x - cg * t) % L) + L) % L - L / 2;
      return Math.exp(-((W * xc) ** 2));
    };
    const carrier = (x) => Math.cos(omega * t - k * x);
    const y = (x) => env(x) * carrier(x);

    ctx.strokeStyle = th.crosshair;
    ctx.lineWidth = 1.6;
    tracePath(ctx, env);
    ctx.stroke();
    ctx.strokeStyle = th.traceMain;
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    tracePath(ctx, y);
    ctx.stroke();
    ctx.restore();
    drawLegend(ctx, th, [
      { color: th.traceMain, label: 'wave (crests at c)' },
      { color: th.crosshair, label: 'envelope (at c_g)' },
    ]);
    roCp.set(c.toFixed(3));
    roCg.set(cg.toFixed(3));
  } else {
    // two components, beam dispersion ω = k²/1000
    const n1 = 30;
    const n2 = n1 + getDn();
    const k1 = 2 * Math.PI * n1;
    const k2 = 2 * Math.PI * n2;
    const w1 = (k1 * k1) / 1000;
    const w2 = (k2 * k2) / 1000;
    const cp = (w1 + w2) / (k1 + k2);
    const cg = (w2 - w1) / (k2 - k1);
    const y = (x) => 0.5 * Math.cos(k1 * x - w1 * t) + 0.5 * Math.cos(k2 * x - w2 * t);
    const env = (x) => Math.cos(((k2 - k1) / 2) * x - ((w2 - w1) / 2) * t);

    ctx.strokeStyle = th.crosshair;
    ctx.lineWidth = 1.6;
    tracePath(ctx, env);
    ctx.stroke();
    ctx.strokeStyle = th.traceMain;
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    tracePath(ctx, y);
    ctx.stroke();

    // markers: one riding the envelope (group), one riding a crest (phase)
    const xg = (((cg * t) % L) + L) % L;
    const xp = (((cp * t) % L) + L) % L;
    ctx.fillStyle = th.label;
    ctx.beginPath();
    ctx.arc(ax.xToPx(xg), ax.yToPx(env(xg)), 7, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = th.tracePeak;
    ctx.beginPath();
    ctx.arc(ax.xToPx(xp), ax.yToPx(env(xp)), 5, 0, 2 * Math.PI);
    ctx.fill();
    ctx.restore();
    drawLegend(ctx, th, [
      { color: th.traceMain, label: 'sum' },
      { color: th.label, label: '● group (c_g)' },
      { color: th.tracePeak, label: '● crest (c_p)' },
    ]);
    roCp.set(cp.toFixed(3));
    roCg.set(cg.toFixed(3));
  }
});
