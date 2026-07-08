// Radix-2 FFT with a real-input wrapper.
// Plain ES module with no dependencies so it runs in the browser, in workers,
// and under `node --test`.

/**
 * In-place iterative radix-2 Cooley-Tukey FFT.
 * @param {Float64Array|Float32Array} re real parts, length must be a power of 2
 * @param {Float64Array|Float32Array} im imaginary parts, same length
 * @param {boolean} inverse if true computes the inverse transform (unscaled;
 *   caller divides by N)
 */
export function fftInPlace(re, im, inverse = false) {
  const n = re.length;
  if (n !== im.length) throw new Error('re/im length mismatch');
  if ((n & (n - 1)) !== 0) throw new Error('FFT size must be a power of 2');

  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cRe = 1, cIm = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const uRe = re[i + k], uIm = im[i + k];
        const vRe = re[i + k + half] * cRe - im[i + k + half] * cIm;
        const vIm = re[i + k + half] * cIm + im[i + k + half] * cRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + half] = uRe - vRe;
        im[i + k + half] = uIm - vIm;
        const nRe = cRe * wRe - cIm * wIm;
        cIm = cRe * wIm + cIm * wRe;
        cRe = nRe;
      }
    }
  }
}

/**
 * Forward FFT of a real signal. Returns the one-sided spectrum:
 * bins 0..N/2 inclusive (N/2+1 complex values).
 *
 * Scratch buffers are reused per size, so this is allocation-free in
 * steady state. Not re-entrant across concurrent calls of the same size
 * (fine for our single-threaded render/worker loops).
 *
 * @param {Float32Array|Float64Array} signal real input, power-of-2 length
 * @returns {{re: Float64Array, im: Float64Array}} one-sided spectrum
 */
const scratch = new Map();
export function rfft(signal) {
  const n = signal.length;
  let buf = scratch.get(n);
  if (!buf) {
    buf = { re: new Float64Array(n), im: new Float64Array(n) };
    scratch.set(n, buf);
  }
  const { re, im } = buf;
  re.set(signal);
  im.fill(0);
  fftInPlace(re, im, false);
  const half = n / 2;
  const outRe = new Float64Array(half + 1);
  const outIm = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) {
    outRe[k] = re[k];
    outIm[k] = im[k];
  }
  return { re: outRe, im: outIm };
}

/**
 * One-sided magnitude-squared spectrum |X[k]|^2 for k = 0..N/2,
 * written into `out` (length N/2+1) if provided.
 */
export function rfftMagSq(signal, out = null) {
  const n = signal.length;
  let buf = scratch.get(n);
  if (!buf) {
    buf = { re: new Float64Array(n), im: new Float64Array(n) };
    scratch.set(n, buf);
  }
  const { re, im } = buf;
  re.set(signal);
  im.fill(0);
  fftInPlace(re, im, false);
  const half = n / 2;
  const result = out ?? new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) {
    result[k] = re[k] * re[k] + im[k] * im[k];
  }
  return result;
}
