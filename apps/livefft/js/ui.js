// Control panel bindings: DOM <-> State, plus view-dependent visibility,
// the settings sheet (narrow screens), tabs, and hover tooltips.

import { DEMO_SOURCES } from '../../../shared/js/audio/engine.js';
import { effectiveFreqScale } from './state.js';

const $ = (id) => document.getElementById(id);

export function initUI(state, engine, callbacks) {
  // ---------- source ----------
  const selSource = $('sel-source');

  function populateSources(mics = []) {
    const current = state.get('source');
    selSource.innerHTML = '';
    const gMic = document.createElement('optgroup');
    gMic.label = 'Microphone';
    if (mics.length === 0) {
      gMic.appendChild(new Option('Default microphone', 'mic'));
    } else {
      for (const d of mics) {
        gMic.appendChild(new Option(d.label || 'Microphone', d.deviceId));
      }
    }
    selSource.appendChild(gMic);
    const gDemo = document.createElement('optgroup');
    gDemo.label = 'Demo signals';
    for (const d of DEMO_SOURCES) gDemo.appendChild(new Option(d.label, d.id));
    selSource.appendChild(gDemo);
    // the start screen's demo picker lists the same demos
    const selDemo = $('sel-demo');
    while (selDemo.options.length > 1) selDemo.remove(1);
    for (const d of DEMO_SOURCES) selDemo.appendChild(new Option(d.label, d.id));
    // restore selection if still present
    if ([...selSource.options].some((o) => o.value === current)) {
      selSource.value = current;
    } else {
      selSource.selectedIndex = 0;
      state.set('source', selSource.value);
    }
  }

  populateSources();
  navigator.mediaDevices?.addEventListener?.('devicechange', async () => {
    populateSources(await engine.listInputDevices());
  });

  selSource.addEventListener('change', () => {
    state.set('source', selSource.value);
    callbacks.onSourceChange?.();
  });
  state.on('source', (v) => {
    if ([...selSource.options].some((o) => o.value === v)) selSource.value = v;
  });

  const rowMonitor = $('row-monitor');
  const rngMonitor = $('rng-monitor');
  rngMonitor.value = state.get('monitorLevel');
  rngMonitor.addEventListener('input', () => {
    state.set('monitorLevel', +rngMonitor.value);
    engine.setMonitor(+rngMonitor.value);
  });

  function updateMonitorRow() {
    rowMonitor.hidden = !state.get('source').startsWith('demo-');
  }

  state.on('source', updateMonitorRow);
  updateMonitorRow();

  // ---------- generic binders ----------
  // All binders are two-way: control -> state, and state -> control so
  // programmatic changes keep the panel honest.
  function bindSelect(id, key, parse = (v) => v) {
    const el = $(id);
    el.value = String(state.get(key));
    el.addEventListener('change', () => state.set(key, parse(el.value)));
    state.on(key, (v) => { el.value = String(v); });
  }

  function bindSeg(name, key, parse = (v) => v) {
    const inputs = document.querySelectorAll(`input[name="${name}"]`);
    for (const input of inputs) {
      input.checked = String(state.get(key)) === input.value;
      input.addEventListener('change', () => {
        if (input.checked) state.set(key, parse(input.value));
      });
    }
    state.on(key, (v) => {
      for (const input of inputs) input.checked = String(v) === input.value;
    });
  }

  function bindSwitch(id, key) {
    const el = $(id);
    el.checked = state.get(key);
    el.addEventListener('change', () => state.set(key, el.checked));
    state.on(key, (v) => { el.checked = v; });
  }

  function bindNumber(id, key, clamp = (v) => v) {
    const el = $(id);
    el.value = state.get(key);
    el.addEventListener('change', () => {
      const v = clamp(parseFloat(el.value));
      if (Number.isFinite(v)) {
        state.set(key, v);
        el.value = v;
      }
    });
    state.on(key, (v) => { el.value = v; });
  }

  // ---------- analysis ----------
  bindSelect('sel-fft', 'fftSize', (v) => parseInt(v, 10));
  bindSelect('sel-window', 'windowName');
  bindSeg('resmode', 'resMode');

  // ---------- averaging ----------
  bindSeg('avgmode', 'avgMode');
  const rngTau = $('rng-tau');
  const roTau = $('ro-tau');
  rngTau.value = Math.log10(state.get('expTimeConst'));
  const fmtTau = (t) => (t < 1 ? `${(t * 1000).toFixed(0)} ms` : `${t.toFixed(1)} s`);
  roTau.textContent = fmtTau(state.get('expTimeConst'));
  rngTau.addEventListener('input', () => {
    const tau = Math.pow(10, +rngTau.value);
    state.set('expTimeConst', tau);
    roTau.textContent = fmtTau(tau);
  });
  bindSelect('sel-linN', 'linearTarget', (v) => parseInt(v, 10));
  $('btn-avg-restart').addEventListener('click', () => callbacks.onAvgRestart?.());

  // ---------- peak hold: a quick toggle on the plot, not in the settings ----------
  const btnHold = $('btn-peakhold');
  const btnPeakReset = $('btn-peakreset');
  const syncPeakTools = () => {
    const on = state.get('peakHold');
    btnHold.classList.toggle('on', on);
    btnHold.setAttribute('aria-pressed', String(on));
    btnPeakReset.hidden = !on;
  };
  btnHold.addEventListener('click', () => state.set('peakHold', !state.get('peakHold')));
  btnPeakReset.addEventListener('click', () => callbacks.onPeakReset?.());
  state.on('peakHold', syncPeakTools);
  syncPeakTools();

  function updateAvgRows() {
    const mode = state.get('avgMode');
    $('row-tau').hidden = mode !== 'exponential';
    $('row-linN').hidden = mode !== 'linear';
  }

  state.on('avgMode', updateAvgRows);
  updateAvgRows();

  // ---------- display ----------
  bindSwitch('sw-db', 'dB');
  bindSwitch('sw-persist', 'persistence');
  bindSelect('sel-peaklabels', 'peakLabels', (v) => parseInt(v, 10));
  bindSeg('labelsize', 'labelSize');

  function updatePersistRow() {
    $('row-persist').hidden = state.get('resMode') === 'multires';
  }

  state.on('resMode', updatePersistRow);
  updatePersistRow();

  // ---------- frequency axis ----------
  bindSeg('fscale', 'freqScale');
  const selFrange = $('sel-frange');

  function syncFrange() {
    const auto = state.get('freqAuto');
    const max = state.get('freqMax');
    const min = state.get('freqMin');
    const isPresetMin = min <= 20.01;
    const preset = [...selFrange.options].find(
      (o) => o.value !== 'auto' && o.value !== 'custom' && +o.value === max
    );
    const customOpt = [...selFrange.options].find((o) => o.value === 'custom');
    if (auto) {
      selFrange.value = 'auto';
      customOpt.hidden = true;
    } else if (preset && isPresetMin) {
      selFrange.value = preset.value;
      customOpt.hidden = true;
    } else {
      customOpt.hidden = false;
      selFrange.value = 'custom';
    }
  }

  selFrange.addEventListener('change', () => {
    if (selFrange.value === 'auto') {
      state.update({ freqAuto: true });
    } else if (selFrange.value !== 'custom') {
      const context = state.get('view') === 'spectrogram' ? 'spectrogram' : 'spectrum';
      const log = effectiveFreqScale(state, context) === 'log';
      state.update({ freqAuto: false, freqMin: log ? 20 : 0, freqMax: +selFrange.value });
    }
  });
  state.on(['freqAuto', 'freqMin', 'freqMax'], syncFrange);
  syncFrange();

  // ---------- amplitude axis ----------
  bindSwitch('sw-ampauto', 'ampAuto');
  bindNumber('num-ampmin', 'ampMin');
  bindNumber('num-ampmax', 'ampMax');

  function updateAmpRows() {
    $('row-amprange').hidden = state.get('ampAuto') || !state.get('dB');
  }

  state.on(['ampAuto', 'dB'], updateAmpRows);
  updateAmpRows();

  // ---------- spectrogram ----------
  bindSeg('sgmode', 'sgMode');
  bindSelect('sel-sgspan', 'sgSpan', (v) => parseFloat(v));
  bindSelect('sel-cmap', 'sgColormap');

  const rngFloor = $('rng-sgfloor');
  const rngCeil = $('rng-sgceil');
  rngFloor.value = state.get('sgFloorDb');
  rngCeil.value = state.get('sgCeilDb');
  $('ro-sgfloor').textContent = state.get('sgFloorDb');
  $('ro-sgceil').textContent = state.get('sgCeilDb');
  rngFloor.addEventListener('input', () => {
    const v = Math.min(+rngFloor.value, state.get('sgCeilDb') - 10);
    rngFloor.value = v;
    state.set('sgFloorDb', v);
    $('ro-sgfloor').textContent = v;
  });
  rngCeil.addEventListener('input', () => {
    const v = Math.max(+rngCeil.value, state.get('sgFloorDb') + 10);
    rngCeil.value = v;
    state.set('sgCeilDb', v);
    $('ro-sgceil').textContent = v;
  });

  bindNumber('num-cwtfmin', 'cwtFMin', (v) => Math.max(5, Math.min(v, state.get('cwtFMax') / 4)));
  bindNumber('num-cwtfmax', 'cwtFMax', (v) => Math.max(state.get('cwtFMin') * 4, v));
  bindSelect('sel-cwtbpo', 'cwtBinsPerOctave', (v) => parseInt(v, 10));
  bindSeg('cwtq', 'cwtOmega0', (v) => parseInt(v, 10));

  function updateCwtRows() {
    const cwt = state.get('sgMode') === 'cwt';
    const specView = state.get('view') === 'spectrogram';
    $('cwt-rows').hidden = !cwt;
    // FFT size / window are the STFT method settings: in the spectrogram
    // view they live directly under the Method toggle; in the spectrum
    // view they belong to the Analysis group
    if (specView) {
      $('cwt-rows').after($('row-fft'));
      $('row-fft').after($('row-window'));
    } else {
      const title = $('grp-analysis').querySelector('.group-title');
      title.after($('row-fft'));
      $('row-fft').after($('row-window'));
    }
    const hideFft = cwt && specView;
    $('row-fft').hidden = hideFft;
    $('row-window').hidden = hideFft;
  }

  state.on('sgMode', updateCwtRows);
  // NOTE: view changes reach updateCwtRows via updateViewVisibility below,
  // which must run first.

  // ---------- scope ----------
  bindSelect('sel-scopespan', 'scopeSpan', (v) => parseFloat(v));
  bindSwitch('sw-trigger', 'scopeTrigger');

  // ---------- view tabs & visibility ----------
  bindSeg('view', 'view');

  function updateViewVisibility() {
    const view = state.get('view');
    document.body.dataset.view = view;
    for (const el of document.querySelectorAll('[data-views]')) {
      el.hidden = !el.dataset.views.split(' ').includes(view);
    }
    updateCwtRows(); // re-homes the method-specific rows
  }

  state.on('view', updateViewVisibility);
  updateViewVisibility();

  // ---------- help overlay ----------
  // Built from the data-tip attributes of whichever controls are visible,
  // so it always explains exactly the current view/mode. This is the
  // touch-friendly counterpart to the desktop hover tooltips.
  const helpOverlay = $('help-overlay');
  const helpBody = $('help-body');
  const VIEW_NAMES = { spectrum: 'Spectrum', spectrogram: 'Spectrogram', scope: 'Scope' };

  function buildHelp() {
    $('help-title').textContent = `${VIEW_NAMES[state.get('view')]} — settings`;
    helpBody.innerHTML = '';

    const addSection = (title, items) => {
      if (!items.length) return;
      const h = document.createElement('h4');
      h.textContent = title;
      const dl = document.createElement('dl');
      for (const [term, text] of items) {
        const dt = document.createElement('dt');
        dt.textContent = term;
        const dd = document.createElement('dd');
        dd.textContent = text;
        dl.append(dt, dd);
      }
      helpBody.append(h, dl);
    };

    addSection('Plot', [
      ['Zoom', 'Drag across the spectrum to zoom the frequency axis (pinch on touch). Double-click or double-tap to reset.'],
      ['Readout', 'Move the pointer (or touch) over the plot for a frequency and level readout at the crosshair.'],
      ['Run / pause', 'The Start button, or the space bar. Pausing freezes the display for discussion. After the app has been in the background, Resume rebuilds the audio input if the phone shut it down.'],
      ['Peak hold', 'Hold (bottom right of the spectrum) keeps the maximum of the displayed trace since the last Reset, shown as the amber trace. With averaging on it holds the averaged level; switch averaging off to catch short transients.'],
      ['Full screen', 'The ⤢ button at the top right of the plot hides every control for a clean projected display; ✕ (or Esc) brings them back. On a phone, tapping the plot also brings them back.'],
      ['Levels', 'The spectrum is a density (dBFS per Hz), the spectrogram is amplitude (dBFS). The same tone therefore reads lower on the spectrum — about 15 dB lower at FFT 4096 — and the gap changes with FFT size and window.'],
      ['Settings', 'On a phone, ☰ opens the settings sheet; drag it down, tap outside it or press Escape to close. Δf sits beside the FFT size, the sample rate beside the input.'],
    ]);

    for (const group of document.querySelectorAll('#panel .group')) {
      if (group.hidden) continue;
      const items = [];
      for (const row of group.querySelectorAll('.row')) {
        if (row.hidden || row.closest('[hidden]')) continue;
        const label = row.querySelector('label[data-tip]');
        if (label) items.push([label.textContent, label.dataset.tip]);
      }
      addSection(group.querySelector('.group-title')?.textContent ?? '', items);
    }
  }

  $('btn-help').addEventListener('click', () => {
    buildHelp();
    helpOverlay.hidden = false;
  });
  $('btn-help-close').addEventListener('click', () => {
    helpOverlay.hidden = true;
  });
  helpOverlay.addEventListener('click', (e) => {
    if (e.target === helpOverlay) helpOverlay.hidden = true;
  });

  // ---------- settings sheet (narrow) / rail (wide) ----------
  const panel = $('panel');
  const scrim = $('scrim');

  function openPanel() {
    document.body.classList.add('panel-open');
    scrim.hidden = false;
  }

  function closePanel() {
    document.body.classList.remove('panel-open');
    scrim.hidden = true;
  }

  $('btn-panel').addEventListener('click', () => {
    if (document.body.classList.contains('panel-open')) closePanel(); else openPanel();
  });
  $('btn-panel-close').addEventListener('click', closePanel);
  scrim.addEventListener('click', closePanel);
  $('plot-wrap').addEventListener('pointerdown', closePanel);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      helpOverlay.hidden = true;
      closePanel();
    }
  });

  // drag the sheet down to close
  const head = $('panel-head');
  let dragY = null;
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    dragY = e.clientY;
    panel.classList.add('dragging');
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener('pointermove', (e) => {
    if (dragY === null) return;
    const dy = Math.max(0, e.clientY - dragY);
    panel.style.transform = `translateY(${dy}px)`;
  });
  const endDrag = (e) => {
    if (dragY === null) return;
    const dy = e.clientY - dragY;
    dragY = null;
    panel.classList.remove('dragging');
    panel.style.transform = '';
    if (dy > 80) closePanel();
  };
  head.addEventListener('pointerup', endDrag);
  head.addEventListener('pointercancel', endDrag);

  // tabs: one per data-tab value among the groups visible in this view
  const TAB_ORDER = ['Analysis', 'Spectrogram', 'Scope', 'Display', 'Axes', 'Source'];
  const tabsNav = $('panel-tabs');

  function updateTabs() {
    const groups = [...document.querySelectorAll('#panel .group')];
    const present = new Set(groups.filter((g) => !g.hidden).map((g) => g.dataset.tab));
    const tabs = TAB_ORDER.filter((t) => present.has(t));
    let active = state.get('settingsTab');
    if (!tabs.includes(active)) active = tabs[0];
    tabsNav.innerHTML = '';
    for (const t of tabs) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t;
      b.classList.toggle('on', t === active);
      b.addEventListener('click', () => state.set('settingsTab', t));
      tabsNav.appendChild(b);
    }
    for (const g of groups) g.classList.toggle('tab-on', g.dataset.tab === active);
  }

  state.on(['settingsTab', 'view'], updateTabs);
  updateTabs();

  // the sheet's title row repeats the header actions that hide on narrow screens
  $('btn-help2').addEventListener('click', () => $('btn-help').click());
  $('btn-theme2').addEventListener('click', () => $('btn-theme').click());

  // ---------- hover tooltips (JS-positioned so the rail never clips them) ----------
  if (window.matchMedia('(hover: hover)').matches) {
    const tip = $('tip');
    let tipFor = null;
    document.addEventListener('pointerover', (e) => {
      const el = e.target.closest?.('[data-tip]');
      if (!el || el === tipFor) return;
      tipFor = el;
      tip.textContent = el.dataset.tip;
      tip.hidden = false;
      const r = el.getBoundingClientRect();
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      const x = Math.min(r.left, window.innerWidth - tw - 8);
      let y = r.bottom + 7;
      if (y + th > window.innerHeight - 8) y = r.top - th - 7;
      tip.style.left = `${Math.max(8, x)}px`;
      tip.style.top = `${Math.max(8, y)}px`;
    });
    document.addEventListener('pointerout', (e) => {
      if (tipFor && !tipFor.contains(e.relatedTarget)) {
        tipFor = null;
        tip.hidden = true;
      }
    });
  }

  return { populateSources, closePanel };
}

/** Transient error/notice toast. */
export function toast(message, ms = 4200) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.hidden = true;
  }, ms);
}
