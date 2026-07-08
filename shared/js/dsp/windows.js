// Window functions and their correction factors.
//
// For a window w[n]:
//   coherent gain      CG  = mean(w)          — corrects amplitude spectra
//   noise gain         NG  = mean(w^2)        — corrects power/PSD spectra
//   equivalent noise bandwidth ENBW = NG / CG^2  (in bins)
//
// Amplitude spectrum of a sine of peak amplitude A shows A when divided
// by (N * CG / 2); PSD integrates to the signal variance when divided
// by (fs * N * NG).

const GENERATORS = {
  rectangular: () => 1,
  hann: (i, n) => 0.5 * (1 - Math.cos((2 * Math.PI * i) / n)),
  hamming: (i, n) => 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / n),
  blackman: (i, n) =>
    0.42 - 0.5 * Math.cos((2 * Math.PI * i) / n) + 0.08 * Math.cos((4 * Math.PI * i) / n),
  // SFT3F flat-top (ISO 18431-2 style): near-zero amplitude error at peaks
  flattop: (i, n) => {
    const x = (2 * Math.PI * i) / n;
    return 0.21557895
      - 0.41663158 * Math.cos(x)
      + 0.277263158 * Math.cos(2 * x)
      - 0.083578947 * Math.cos(3 * x)
      + 0.006947368 * Math.cos(4 * x);
  },
};

export const WINDOW_NAMES = Object.keys(GENERATORS);

const cache = new Map();

/**
 * Get (cached) window samples plus correction factors.
 * Uses the periodic form (denominator n, not n-1), which is the right
 * convention for spectral analysis with overlapping segments.
 * @param {string} name one of WINDOW_NAMES
 * @param {number} n window length
 * @returns {{w: Float64Array, coherentGain: number, noiseGain: number, enbwBins: number}}
 */
export function getWindow(name, n) {
  const key = `${name}:${n}`;
  let entry = cache.get(key);
  if (entry) return entry;

  const gen = GENERATORS[name];
  if (!gen) throw new Error(`Unknown window: ${name}`);
  const w = new Float64Array(n);
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const v = gen(i, n);
    w[i] = v;
    sum += v;
    sumSq += v * v;
  }
  const coherentGain = sum / n;
  const noiseGain = sumSq / n;
  entry = { w, coherentGain, noiseGain, enbwBins: noiseGain / (coherentGain * coherentGain) };
  cache.set(key, entry);
  return entry;
}

/** Multiply signal by window into `out` (may alias signal). */
export function applyWindow(signal, w, out) {
  const n = signal.length;
  for (let i = 0; i < n; i++) out[i] = signal[i] * w[i];
  return out;
}
