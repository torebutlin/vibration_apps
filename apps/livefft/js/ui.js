// Control panel bindings: DOM <-> State, plus view-dependent visibility.

import { DEMO_SOURCES } from '../../../shared/js/audio/engine.js';

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
  bindSeg('quantity', 'quantity');

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
  bindSwitch('sw-peakhold', 'peakHold');
  $('btn-peakreset').addEventListener('click', () => callbacks.onPeakReset?.());

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
      const log = state.get('freqScale') === 'log';
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
    $('cwt-rows').hidden = state.get('sgMode') !== 'cwt';
  }

  state.on('sgMode', updateCwtRows);
  updateCwtRows();

  // ---------- scope ----------
  bindSelect('sel-scopespan', 'scopeSpan', (v) => parseFloat(v));
  bindSwitch('sw-trigger', 'scopeTrigger');

  // ---------- view tabs & visibility ----------
  bindSeg('view', 'view');

  function updateViewVisibility() {
    const view = state.get('view');
    for (const el of document.querySelectorAll('[data-views]')) {
      el.hidden = !el.dataset.views.split(' ').includes(view);
    }
  }

  state.on('view', updateViewVisibility);
  updateViewVisibility();

  // ---------- panel drawer (mobile) ----------
  $('btn-panel').addEventListener('click', () => {
    document.body.classList.toggle('panel-open');
  });
  // close drawer when tapping the stage
  $('plot-wrap').addEventListener('pointerdown', () => {
    document.body.classList.remove('panel-open');
  });

  return { populateSources };
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
