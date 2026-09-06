// App settings: single store with change notification and localStorage
// persistence. Transient runtime state (running, overload) is kept out of
// persistence.

const STORAGE_KEY = 'livefft-settings-v1';

export const DEFAULTS = {
  view: 'spectrum',          // spectrum | spectrogram | scope
  source: 'mic',

  // spectrum analysis (displayed quantity is always PSD; averaging off =
  // live FFT, averaging on = Welch estimate)
  fftSize: 4096,
  windowName: 'hann',
  dB: true,
  resMode: 'standard',       // standard | multires
  avgMode: 'exponential',    // off | exponential | linear
  expTimeConst: 0.5,
  linearTarget: 16,
  peakHold: false,
  peakLabels: 4,
  labelSize: 'std',          // std | big (lecture projection)
  persistence: true,

  // frequency axis (shared: spectrum x, spectrogram y, and the range the
  // wavelet spectrogram analyses)
  freqScale: 'auto',         // auto | linear | log
  freqMin: 20,
  freqMax: 5000,
  freqAuto: false,           // true = full 0..fs/2 (or 20..fs/2 in log)

  // amplitude axis
  ampAuto: true,
  ampMin: -110,
  ampMax: 5,

  // spectrogram
  sgMode: 'stft',            // stft | cwt
  sgSpan: 10,                // seconds
  sgColormap: 'inferno',
  sgFloorDb: -95,
  sgCeilDb: -15,
  cwtBinsPerOctave: 16,      // manual value; used when cwtBpoAuto is false
  cwtBpoAuto: true,          // follow Wavelet Q (see recommendedBinsPerOctave)
  cwtOmega0: 12,

  // scope
  scopeSpan: 0.05,           // seconds
  scopeTrigger: true,

  monitorLevel: 0,
  settingsTab: 'Analysis',   // active settings-sheet tab on narrow screens
};

/**
 * Resolve the frequency-axis scale. 'auto' matches the analysis: log for
 * the wavelet spectrogram and multi-res spectrum (their resolution is
 * frequency-proportional), linear for STFT and fixed-resolution FFT.
 * @param {State} state
 * @param {'spectrum'|'spectrogram'} context which view's axis is being drawn
 */
export function effectiveFreqScale(state, context) {
  const v = state.get('freqScale');
  if (v !== 'auto') return v;
  if (context === 'spectrogram') return state.get('sgMode') === 'cwt' ? 'log' : 'linear';
  return state.get('resMode') === 'multires' ? 'log' : 'linear';
}

/**
 * Lowest frequency the wavelet spectrogram analyses. The Morlet transform
 * has no zero-frequency scale, and going lower costs a longer wavelet: the
 * display trails real time by about 4 sigma = 2 omega0 / (pi f_min). 20 Hz
 * is the bottom of the audible band and the floor the log axis already
 * uses, so the range control needs no separate wavelet limit.
 */
export const CWT_FLOOR_HZ = 20;

/**
 * Frequency range for a view: the Range setting, clamped to what the
 * analysis can deliver. Full is 0..fs/2 (from 20 Hz on a log axis). The
 * wavelet spectrogram analyses exactly the displayed range, starting no
 * lower than CWT_FLOOR_HZ whatever the axis scale.
 * @param {State} state
 * @param {'spectrum'|'spectrogram'} context
 * @param {number} sampleRate
 * @returns {{min: number, max: number, log: boolean}}
 */
export function freqRange(state, context, sampleRate = 48000) {
  const log = effectiveFreqScale(state, context) === 'log';
  const nyquist = sampleRate / 2;
  const cwt = context === 'spectrogram' && state.get('sgMode') === 'cwt';
  let min;
  let max;
  if (state.get('freqAuto')) {
    min = log ? CWT_FLOOR_HZ : 0;
    max = nyquist;
  } else {
    min = state.get('freqMin');
    max = Math.min(state.get('freqMax'), nyquist);
  }
  if (cwt) min = Math.max(min, CWT_FLOOR_HZ);
  else if (log) min = Math.max(min, 1);
  // a zoom kept from a higher sample rate can leave the range inverted
  if (min >= max) min = max / 2;
  return { min, max, log };
}

/** Bins-per-octave choices offered for the wavelet spectrogram. */
export const CWT_BPO_OPTIONS = [8, 12, 16, 24, 32, 48, 64];

/**
 * Scale density that matches the Morlet resolution. A wavelet at centre
 * frequency f responds over a Gaussian band of width σ_f = f / ω₀, so two
 * scales per σ_f means a ratio 2^(1/B) = 1 + 1/(2ω₀) between neighbours,
 * i.e. B ≈ 2 ω₀ ln 2 bins per octave: 8 / 16 / 32 for ω₀ = 6 / 12 / 24.
 * Denser sampling only smooths the picture — the resolution is set by ω₀.
 * @param {number} omega0 Morlet parameter
 * @param {number[]} options offered values; the nearest (in ratio) is returned
 */
export function recommendedBinsPerOctave(omega0, options = CWT_BPO_OPTIONS) {
  const ideal = 1 / Math.log2(1 + 1 / (2 * omega0));
  let best = options[0];
  for (const o of options) {
    if (Math.abs(Math.log(o / ideal)) < Math.abs(Math.log(best / ideal))) best = o;
  }
  return best;
}

/** Bins per octave the wavelet spectrogram actually uses: the Q-matched
 *  value while Auto, otherwise the manual setting. */
export function effectiveBinsPerOctave(state) {
  return state.get('cwtBpoAuto')
    ? recommendedBinsPerOctave(state.get('cwtOmega0'))
    : state.get('cwtBinsPerOctave');
}

export class State {
  constructor() {
    this.values = { ...DEFAULTS };
    this.listeners = new Map(); // key -> Set<fn>; '*' = any
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      for (const k of Object.keys(DEFAULTS)) {
        if (k in saved && typeof saved[k] === typeof DEFAULTS[k]) this.values[k] = saved[k];
      }
    } catch { /* fresh start */ }
  }

  get(key) {
    return this.values[key];
  }

  set(key, value) {
    if (this.values[key] === value) return;
    this.values[key] = value;
    this.#emit(key, value);
    this.#save();
  }

  /** Set several keys, emitting once each but saving once. All values are
   *  stored before any listener runs, so listeners see the whole patch. */
  update(patch) {
    const changed = [];
    for (const [k, v] of Object.entries(patch)) {
      if (this.values[k] !== v) {
        this.values[k] = v;
        changed.push(k);
      }
    }
    for (const k of changed) this.#emit(k, this.values[k]);
    this.#save();
  }

  on(keys, fn) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (!this.listeners.has(key)) this.listeners.set(key, new Set());
      this.listeners.get(key).add(fn);
    }
  }

  #emit(key, value) {
    this.listeners.get(key)?.forEach((fn) => fn(value, key));
    this.listeners.get('*')?.forEach((fn) => fn(value, key));
  }

  #save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.values));
      } catch { /* private mode */ }
    }, 300);
  }
}
