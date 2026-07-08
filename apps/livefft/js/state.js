// App settings: single store with change notification and localStorage
// persistence. Transient runtime state (running, overload) is kept out of
// persistence.

const STORAGE_KEY = 'livefft-settings-v1';

export const DEFAULTS = {
  view: 'spectrum',          // spectrum | spectrogram | scope
  source: 'mic',

  // spectrum analysis
  fftSize: 4096,
  windowName: 'hann',
  quantity: 'amplitude',     // amplitude | rms | psd
  dB: true,
  resMode: 'standard',       // standard | multires
  avgMode: 'exponential',    // off | exponential | linear
  expTimeConst: 0.5,
  linearTarget: 16,
  peakHold: false,
  peakLabels: 4,
  persistence: true,

  // frequency axis (shared: spectrum x, spectrogram y)
  freqScale: 'linear',       // linear | log
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
  cwtFMin: 30,
  cwtFMax: 4000,
  cwtBinsPerOctave: 16,
  cwtOmega0: 12,

  // scope
  scopeSpan: 0.05,           // seconds
  scopeTrigger: true,

  monitorLevel: 0,
};

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

  /** Set several keys, emitting once each but saving once. */
  update(patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (this.values[k] !== v) {
        this.values[k] = v;
        this.#emit(k, v);
      }
    }
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
