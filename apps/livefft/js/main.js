// Live FFT app: boot, render loop, interaction and readouts.

import { AudioEngine } from '../../../shared/js/audio/engine.js';
import { PlotInteraction } from '../../../shared/js/plot/interaction.js';
import { fmtHz } from '../../../shared/js/plot/axes.js';
import { State } from './state.js';
import { SpectrumView } from './views/spectrum.js';
import { SpectrogramView } from './views/spectrogram.js';
import { ScopeView } from './views/scope.js';
import { initUI, toast } from './ui.js';

const state = new State();
const engine = new AudioEngine(new URL('../../../shared/js/audio/capture-worklet.js', import.meta.url).href);

const views = {
  spectrum: new SpectrumView(state),
  spectrogram: new SpectrogramView(state),
  scope: new ScopeView(state),
};

const canvas = document.getElementById('plot');
const ctx = canvas.getContext('2d');
const btnRun = document.getElementById('btn-run');
const overlayMsg = document.getElementById('overlay-msg');
const lampClip = document.getElementById('lamp-clip');

let cssW = 0;
let cssH = 0;
let hover = null;
let lastClip = 0;
let lastFrame = performance.now();
let started = false;

// ---------- canvas sizing ----------

function resizeCanvas() {
  const wrap = document.getElementById('plot-wrap');
  const rect = wrap.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cssW = Math.round(rect.width);
  cssH = Math.round(rect.height);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

new ResizeObserver(resizeCanvas).observe(document.getElementById('plot-wrap'));
resizeCanvas();

// ---------- interaction ----------

function activeView() {
  return views[state.get('view')];
}

const interaction = new PlotInteraction(canvas, views.spectrum.axes, {
  onXRange(min, max) {
    if (state.get('view') !== 'spectrum') return;
    const fs = engine.sampleRate;
    const log = state.get('freqScale') === 'log';
    min = Math.max(log ? 1 : 0, min);
    max = Math.min(fs / 2, max);
    if (max - min < 10) return;
    state.update({ freqAuto: false, freqMin: Math.round(min * 10) / 10, freqMax: Math.round(max * 10) / 10 });
  },
  onReset() {
    if (state.get('view') !== 'spectrum') return;
    state.update({ freqAuto: true });
  },
  onHover(x, y) {
    hover = x === null ? null : { x, y };
  },
});

// ---------- engine start / pause ----------

async function startEngine() {
  const source = state.get('source');
  btnRun.disabled = true;
  try {
    await engine.start(source);
    engine.setMonitor(source.startsWith('demo-') ? state.get('monitorLevel') : 0);
    started = true;
    overlayMsg.hidden = true;
    document.body.classList.add('running');
    btnRun.textContent = '❚❚ Pause';
    // views need the real sample rate
    for (const v of Object.values(views)) v.setSampleRate(engine.sampleRate);
    // now that permission may exist, repopulate device labels
    if (!source.startsWith('demo-')) {
      ui.populateSources(await engine.listInputDevices());
    }
  } catch (err) {
    console.error(err);
    toast(
      err.name === 'NotAllowedError'
        ? 'Microphone access was denied. Try a demo signal instead, or allow the microphone in your browser settings.'
        : `Could not start audio: ${err.message}`
    );
  } finally {
    btnRun.disabled = false;
  }
}

async function toggleRun() {
  if (!started) {
    await startEngine();
    return;
  }
  if (engine.running) {
    await engine.pause();
    document.body.classList.remove('running');
    btnRun.textContent = '▶ Resume';
  } else {
    await engine.resume();
    document.body.classList.add('running');
    btnRun.textContent = '❚❚ Pause';
  }
}

btnRun.addEventListener('click', toggleRun);

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(document.activeElement?.tagName)) {
    e.preventDefault();
    toggleRun();
  }
});

engine.onOverload = () => {
  lastClip = performance.now();
};

// ---------- theme ----------

const btnTheme = document.getElementById('btn-theme');

// ︎ forces text (not emoji) rendering of the sun/moon glyphs
const THEME_GLYPH = { dark: '☀︎', light: '☽︎' };

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('vibapps-theme', theme); } catch { /* private mode */ }
  btnTheme.textContent = THEME_GLYPH[theme];
  window.dispatchEvent(new Event('themechange'));
}

btnTheme.textContent = THEME_GLYPH[document.documentElement.dataset.theme || 'dark'];
btnTheme.addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

const ui = initUI(state, engine, {
  onSourceChange() {
    if (started && engine.running) startEngine(); // hot-swap source
  },
  onAvgRestart() {
    views.spectrum.resetAverage();
  },
  onPeakReset() {
    views.spectrum.resetPeakHold();
  },
});

state.on('view', () => {
  hover = null;
  interaction.axes = activeView().axes;
});
interaction.axes = activeView().axes;

state.on('monitorLevel', (v) => {
  if (started && state.get('source').startsWith('demo-')) engine.setMonitor(v);
});

// ---------- readouts ----------

const roFs = document.getElementById('ro-fs');
const roRes = document.getElementById('ro-res');
const roPeak = document.getElementById('ro-peak');
const roPeakWrap = document.getElementById('ro-peak-wrap');
const roAvg = document.getElementById('ro-avg');
const roAvgWrap = document.getElementById('ro-avg-wrap');
let lastReadout = 0;

function updateReadouts(now) {
  if (now - lastReadout < 250) return;
  lastReadout = now;
  const view = state.get('view');
  roFs.textContent = started ? engine.sampleRate : '—';
  if (view === 'spectrum') {
    roRes.textContent = views.spectrum.resolutionText;
    const p = views.spectrum.dominantPeak;
    roPeakWrap.hidden = false;
    roPeak.textContent = p ? (p.freq >= 1000 ? `${(p.freq / 1000).toFixed(3)} kHz` : `${p.freq.toFixed(1)} Hz`) : '—';
    const prog = views.spectrum.avgProgress;
    roAvgWrap.hidden = !prog;
    if (prog) roAvg.textContent = `${prog.count}/${prog.target}${prog.done ? ' ✓' : ''}`;
  } else {
    roPeakWrap.hidden = true;
    roAvgWrap.hidden = true;
    if (view === 'spectrogram') {
      const s = views.spectrogram;
      roRes.textContent = s.isCwt
        ? `CWT ${state.get('cwtBinsPerOctave')}/oct`
        : `${(engine.sampleRate / state.get('fftSize')).toFixed(1)} Hz`;
    } else {
      const span = state.get('scopeSpan');
      roRes.textContent = span < 1 ? `${(span * 1000).toFixed(0)} ms` : `${span} s`;
    }
  }
  lampClip.classList.toggle('on', now - lastClip < 600);
}

// ---------- main loop ----------

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastFrame) / 1000, 0.2);
  lastFrame = now;
  if (cssW < 10 || cssH < 10) return;

  const view = activeView();
  if (started && engine.running) view.tick(engine, dt);
  view.render(ctx, cssW, cssH, hover, view === views.spectrum ? interaction.rubberBand : null);
  updateReadouts(now);
}

requestAnimationFrame(frame);

// Debug/testing handle (also handy in the browser console)
window.__livefft = { engine, state, views, interaction };

// ---------- service worker ----------

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support optional */ });
  });
}
