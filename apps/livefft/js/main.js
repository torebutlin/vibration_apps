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
  // height (10 px gap + 40 px pill + 10 px gap) so axes and labels stay
  // visible — except in full view, where the pills are gone and the plot
  // takes the whole screen (inside the safe areas)
  const pills = document.body.classList.contains('fullview') ? 0 : 60;
  layout.padTop = layout.compact ? pills + safeInset('--sat') : 0;
  layout.padBottom = layout.compact ? safeInset('--sab') : 0;
}

// The app is one screenful: it fills the viewport and never scrolls. CSS
// viewport units are not enough to say that on a phone — after a rotation a
// browser can leave 100dvh resolving to a viewport taller than the one it
// is actually showing, and the page is then scrollable by the difference. A
// rotation back to portrait would land it scrolled to the bottom: blank
// ground under the plot, and the full-screen button off the top of the
// screen with no way to leave full view. So the height comes from the
// viewport the browser reports, and any scroll offset is undone.
function applyViewportSize() {
  const vv = window.visualViewport;
  // while the page is pinch-zoomed vv.height is the zoomed-in slice; the
  // scale factor takes it back to the layout height the app should fill
  const h = vv ? vv.height * vv.scale : window.innerHeight;
  const px = `${Math.round(h)}px`;
  const root = document.documentElement;
  if (h > 0 && px !== root.style.getPropertyValue('--app-h')) root.style.setProperty('--app-h', px);
  if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
}

function settleViewport() {
  applyViewportSize();
  applyLayout();
  resizeCanvas();
}

// Phones can change the viewport without an event the app can trust: a
// rotation the media query reports before the layout has caught up, browser
// chrome that slides away, a scroll position nobody asked for. Twice a
// second, check that the app still covers exactly what is on screen, and
// put it back when it does not.
const appEl = document.getElementById('app');
let lastViewportCheck = 0;

function checkViewport(now) {
  if (now - lastViewportCheck < 500) return;
  lastViewportCheck = now;
  const vv = window.visualViewport;
  const want = Math.round(vv ? vv.height * vv.scale : window.innerHeight);
  const have = Math.round(appEl.getBoundingClientRect().height);
  if (window.scrollX !== 0 || window.scrollY !== 0 || Math.abs(have - want) > 1) settleViewport();
}

// Rotating the device changes which safe-area insets are non-zero, but the
// media-query event can arrive before the browser has finished laying the
// page out, so env() still reads the old orientation. Re-apply as the
// viewport settles rather than trusting the first reading — and note when
// a rotation happened: a native full screen that ends inside that window
// was dropped by the rotation, not by the user (see setFullview).
let lastRotation = 0;
const ROTATE_GRACE_MS = 1500;

function onRotate() {
  lastRotation = performance.now();
  settleViewport();
  // the rotation animation and the browser chrome that follows it can take
  // most of a second to come to rest
  for (const ms of [50, 250, 600, 1000]) setTimeout(settleViewport, ms);
}

mqNarrow.addEventListener('change', settleViewport);
mqPortrait.addEventListener('change', onRotate);
window.addEventListener('orientationchange', onRotate);
screen.orientation?.addEventListener?.('change', onRotate);
// entering or leaving full screen, and the phone browser's own chrome
// appearing, move the insets too
window.addEventListener('resize', settleViewport);
window.visualViewport?.addEventListener('resize', settleViewport);
// nothing in the app scrolls the page; if the browser did, put it back
window.addEventListener('scroll', applyViewportSize, { passive: true });
window.visualViewport?.addEventListener('scroll', applyViewportSize);
applyViewportSize();
applyLayout();

// ---------- canvas sizing ----------

function resizeCanvas() {
  const wrap = document.getElementById('plot-wrap');
  const rect = wrap.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  // setting width or height clears the canvas, so only touch them on a real
  // change: this is called from every viewport event and settle timer
  if (w === cssW && h === cssH && canvas.width === bw && canvas.height === bh) return;
  cssW = w;
  cssH = h;
  canvas.width = bw;
  canvas.height = bh;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

new ResizeObserver(resizeCanvas).observe(document.getElementById('plot-wrap'));
resizeCanvas();

// ---------- interaction ----------

function activeView() {
  return views[state.get('view')];
}

// Zooming the frequency axis writes the same setting the Range control
// does, so the app keeps the chosen range: whatever the Range control (or
// the defaults) last said, as opposed to the temporary look a drag or a
// pinch gives. A reset comes back to it — the teaching setup opens at
// 0–2 kHz, and that is where a double tap should land.
const rangeKeys = ['freqAuto', 'freqMin', 'freqMax'];
const currentRange = () => Object.fromEntries(rangeKeys.map((k) => [k, state.get(k)]));
let chosenRange = currentRange();
let zoomingRange = false;

function zoomRange(patch) {
  zoomingRange = true;
  state.update(patch);
  zoomingRange = false;
}

// The wavelet spectrogram analyses exactly the range it displays, so every
// change restarts it. A pinch would do that on each frame of the gesture:
// hold the last one until the fingers stop, then apply it once.
let sgZoomTimer = null;

function zoomRangeSettled(patch) {
  clearTimeout(sgZoomTimer);
  sgZoomTimer = setTimeout(() => zoomRange(patch), 150);
}

/** Frequency range from a zoom gesture, clamped to what can be analysed. */
function zoomedRange(min, max, context) {
  const log = effectiveFreqScale(state, context) === 'log';
  min = Math.max(log ? 1 : 0, min);
  max = Math.min(engine.sampleRate / 2, max);
  if (max - min < 10) return null;
  return { freqAuto: false, freqMin: Math.round(min * 10) / 10, freqMax: Math.round(max * 10) / 10 };
}

const interaction = new PlotInteraction(canvas, views.spectrum.axes, {
  onXRange(min, max) {
    if (state.get('view') !== 'spectrum') return;
    const patch = zoomedRange(min, max, 'spectrum');
    if (patch) zoomRange(patch);
  },
  // the spectrogram's frequency axis is the vertical one
  onYRange(min, max) {
    if (state.get('view') !== 'spectrogram') return;
    const patch = zoomedRange(min, max, 'spectrogram');
    if (patch) zoomRangeSettled(patch);
  },
  onReset() {
    if (state.get('view') === 'scope') return;
    clearTimeout(sgZoomTimer);
    zoomRange(chosenRange);
  },
  onHover(x, y) {
    hover = x === null ? null : { x, y };
  },
  onTap() {
    // on a phone the chrome is hidden in full view; a tap brings it back
    if (layout.compact && fullview) setFullview(false);
  },
});

// anything that is not a zoom gesture — the Range control, mostly — is the
// user choosing a range, and that is what a reset returns to
state.on(rangeKeys, () => {
  if (!zoomingRange) chosenRange = currentRange();
});

// PlotInteraction leaves vertical drags to the page, for a plot that sits in
// one that scrolls. This app is a single screenful: a swipe over the plot
// must not drag it out of place, so the canvas takes every touch.
canvas.style.touchAction = 'none';

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
  if (e.key === 'Escape' && fullview) setFullview(false);
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
//
// Two things can get out of step: the app's own chrome-free layout
// (body.fullview) and the browser's native full screen. Only the first is
// always available — iOS Safari has no element full screen at all, and
// browsers can drop the native one by themselves, notably when the device
// rotates. So body.fullview is the state the button reflects, since it is
// what the user sees, and the button always undoes both.

const btnFull = document.getElementById('btn-full');

const fullscreenApi = {
  element: () => document.fullscreenElement || document.webkitFullscreenElement || null,
  request(el) {
    const fn = el.requestFullscreen || el.webkitRequestFullscreen;
    try {
      return Promise.resolve(fn?.call(el));
    } catch {
      return Promise.resolve();
    }
  },
  exit() {
    const fn = document.exitFullscreen || document.webkitExitFullscreen;
    try {
      return Promise.resolve(fn?.call(document));
    } catch {
      return Promise.resolve();
    }
  },
};

let fullview = false;

function syncFullButton() {
  btnFull.textContent = fullview ? '✕' : '⤢';
  btnFull.title = fullview ? 'Exit full screen (Esc)' : 'Full screen — hide all controls';
  btnFull.setAttribute('aria-label', fullview ? 'Exit full screen' : 'Full screen');
}

/**
 * @param {boolean} on
 * @param {boolean} [native] also ask the browser to enter or leave its own
 *   full screen. False when we are merely following a change it made.
 */
function setFullview(on, native = true) {
  fullview = on;
  document.body.classList.toggle('fullview', on);
  applyLayout(); // phones: the plot reclaims the pill row
  syncFullButton();
  // the viewport changes size as the browser's own chrome goes and returns
  settleViewport();
  for (const ms of [50, 250, 600]) setTimeout(settleViewport, ms);
  if (!native) return;
  if (on) {
    fullscreenApi.request(document.documentElement).catch(() => { /* iOS: CSS-only */ });
  } else if (fullscreenApi.element()) {
    fullscreenApi.exit().catch(() => { /* already out */ });
  }
}

function onFullscreenChange() {
  if (fullscreenApi.element()) {
    // the browser put us in full screen without being asked: follow it
    if (!fullview) setFullview(true, false);
    return;
  }
  if (!fullview) return;
  // Native full screen ended. Usually that is Esc or the browser's own
  // gesture and the controls should come back — but a rotation can drop it
  // on its own, which is not a request for them, and there is no user
  // gesture left to re-enter with. Stay in the full view; the button (now
  // the only way out, and still reading ✕) does the rest.
  if (performance.now() - lastRotation < ROTATE_GRACE_MS) return;
  setFullview(false, false);
}

btnFull.addEventListener('click', () => setFullview(!fullview));
document.addEventListener('fullscreenchange', onFullscreenChange);
document.addEventListener('webkitfullscreenchange', onFullscreenChange);
syncFullButton();

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

function bindInteraction() {
  interaction.axes = activeView().axes;
  // frequency runs across the spectrum and up the spectrogram
  interaction.zoomAxis = state.get('view') === 'spectrogram' ? 'y' : 'x';
}

state.on('view', () => {
  hover = null;
  bindInteraction();
});
bindInteraction();

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
const roCwtRange = document.getElementById('ro-cwtrange');
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
        ? `CWT ${s.binsPerOctave}/oct`
        : fmtRes(engine.sampleRate / state.get('fftSize'));
      // the wavelet band follows the axis range: show what it works out as
      if (s.isCwt && roCwtRange) roCwtRange.textContent = s.cwtRangeText;
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
  checkViewport(now);
  if (cssW < 10 || cssH < 10) return;

  const view = activeView();
  if (started && engine.running) view.tick(engine, dt);
  view.render(ctx, cssW, cssH, hover, view === views.spectrum ? interaction.rubberBand : null, layout);
  updateReadouts(now);
}

requestAnimationFrame(frame);

// Debug/testing handle (also handy in the browser console)
window.__livefft = { engine, state, views, interaction };

// The service worker is registered by the boot script in index.html, not
// here: it also has to run when this module fails to load.
