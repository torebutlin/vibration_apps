// Live FFT app: boot, render loop, interaction and readouts.

import { AudioEngine } from '../../../shared/js/audio/engine.js';
import { PlotInteraction } from '../../../shared/js/plot/interaction.js';
import { State, effectiveFreqScale } from './state.js';
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

// ---------- responsive layout ----------
// narrow: chrome floats over the plot; portrait narrow: y labels inside.
const mqNarrow = window.matchMedia('(max-width: 860px)');
const mqPortrait = window.matchMedia('(orientation: portrait)');
const layout = { compact: false, yInside: false, padTop: 0, padBottom: 0 };

// safe-area insets, exposed by app.css as --sat / --sab so the canvas can
// keep its axes clear of the notch and the home indicator
function safeInset(name) {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0;
}

function applyLayout() {
  layout.compact = mqNarrow.matches;
  layout.yInside = mqNarrow.matches && mqPortrait.matches;
  // on narrow screens the pill row floats over the canvas: reserve its
  // height (10 px gap + 40 px pill + 10 px gap) so axes and labels stay visible
  layout.padTop = layout.compact ? 60 + safeInset('--sat') : 0;
  layout.padBottom = layout.compact ? safeInset('--sab') : 0;
}

mqNarrow.addEventListener('change', applyLayout);
mqPortrait.addEventListener('change', applyLayout);
applyLayout();

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
    const log = effectiveFreqScale(state, 'spectrum') === 'log';
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
  onTap() {
    // on a phone the chrome is hidden in full view; a tap brings it back
    if (layout.compact && document.body.classList.contains('fullview')) setFullview(false);
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
    document.getElementById('plot-wrap').classList.remove('idle');
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
    return;
  }
  btnRun.disabled = true;
  try {
    // self-healing: rebuilds the audio graph if the platform tore it down
    await engine.resume();
    if (!engine.running) throw new Error('audio did not resume');
    document.body.classList.add('running');
    btnRun.textContent = '❚❚ Pause';
    for (const v of Object.values(views)) v.setSampleRate(engine.sampleRate);
  } catch (err) {
    console.error(err);
    toast('Audio could not resume — restarting the source.');
    started = false;
    await startEngine();
  } finally {
    btnRun.disabled = false;
  }
}

btnRun.addEventListener('click', toggleRun);

// start-screen actions: microphone, or a demo signal picked from the list
document.getElementById('btn-start-mic').addEventListener('click', () => {
  state.set('source', 'mic');
  startEngine();
});
document.getElementById('sel-demo').addEventListener('change', (e) => {
  if (!e.target.value) return;
  state.set('source', e.target.value);
  startEngine();
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(document.activeElement?.tagName)) {
    e.preventDefault();
    toggleRun();
  }
  if (e.key === 'Escape' && document.body.classList.contains('fullview')) setFullview(false);
});

// Coming back from the background: the platform may have suspended or
// closed the audio graph (or ended the mic track). resume() self-heals.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && started && engine.running) {
    engine.resume().catch((err) => console.error(err));
  }
});

engine.onOverload = () => {
  lastClip = performance.now();
};

// ---------- full-screen view ----------
// One button at the plot's top-right toggles; it reads ⤢ or ✕.

const btnFull = document.getElementById('btn-full');

function setFullview(on) {
  document.body.classList.toggle('fullview', on);
  btnFull.textContent = on ? '✕' : '⤢';
  btnFull.title = on ? 'Exit full screen (Esc)' : 'Full screen — hide all controls';
  btnFull.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
  if (on) {
    document.documentElement.requestFullscreen?.().catch(() => { /* iOS: CSS-only */ });
  } else if (document.fullscreenElement) {
    document.exitFullscreen?.();
  }
}

btnFull.addEventListener('click', () => setFullview(!document.body.classList.contains('fullview')));
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) setFullview(false);
});

// ---------- theme ----------

const btnTheme = document.getElementById('btn-theme');
const btnTheme2 = document.getElementById('btn-theme2');
const metaTheme = document.querySelector('meta[name="theme-color"]');

// ︎ forces text (not emoji) rendering of the sun/moon glyphs
const THEME_GLYPH = { dark: '☀︎', light: '☽︎' };

function syncThemeColor() {
  // browser chrome / status bar follows the page ground of the active theme
  if (metaTheme) metaTheme.content = getComputedStyle(document.documentElement).getPropertyValue('--bg-page').trim();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('vibapps-theme', theme); } catch { /* private mode */ }
  btnTheme.textContent = THEME_GLYPH[theme];
  btnTheme2.textContent = THEME_GLYPH[theme];
  syncThemeColor();
  window.dispatchEvent(new Event('themechange'));
}

btnTheme.textContent = THEME_GLYPH[document.documentElement.dataset.theme || 'dark'];
btnTheme2.textContent = btnTheme.textContent;
syncThemeColor();
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
const roFs2 = document.getElementById('ro-fs2');
const roRes2 = document.getElementById('ro-res2');
let lastReadout = 0;

function fmtRes(binHz) {
  return `${binHz.toFixed(binHz < 10 ? 2 : 1)} Hz`;
}

function updateReadouts(now) {
  if (now - lastReadout < 250) return;
  lastReadout = now;
  const view = state.get('view');
  roFs.textContent = started ? engine.sampleRate : '—';
  // beside the settings: sample rate next to Input, Δf next to FFT size
  roFs2.textContent = started ? `${(engine.sampleRate / 1000).toFixed(1)} kHz` : '—';
  roRes2.textContent = `Δf ${fmtRes(engine.sampleRate / state.get('fftSize'))}`;
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
        : fmtRes(engine.sampleRate / state.get('fftSize'));
    } else {
      const span = state.get('scopeSpan');
      roRes.textContent = span < 1 ? `${(span * 1000).toFixed(0)} ms` : `${span} s`;
    }
  }
  const clipping = now - lastClip < 600;
  lampClip.classList.toggle('on', clipping);
  document.body.classList.toggle('clipping', clipping);
}

// ---------- main loop ----------

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastFrame) / 1000, 0.2);
  lastFrame = now;
  if (cssW < 10 || cssH < 10) return;

  const view = activeView();
  if (started && engine.running) view.tick(engine, dt);
  view.render(ctx, cssW, cssH, hover, view === views.spectrum ? interaction.rubberBand : null, layout);
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
