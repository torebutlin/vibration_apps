// Continuous wavelet transform (Morlet) for live multi-resolution
// time-frequency analysis.
//
// Method: one real FFT of a long full-rate block, then for each scale a
// Gaussian bandpass (the analytic Morlet wavelet in the frequency domain)
// is applied and inverted with a small complex IFFT. Decimation to the
// analysis rate is free: truncating the spectrum to the first M/D bins IS
// brick-wall decimation by D. Filters use only positive frequencies
// (doubled), so each IFFT yields the analytic signal at that scale and
// |y| reads directly as the amplitude of a tone at the scale's centre
// frequency.
//
// Circular convolution wraps at the block edges, so output columns are
// only valid at least `latency` samples away from the newest edge, where
// latency = 4 sigma of the widest (lowest-frequency) wavelet. The live
// display therefore trails real time by that fixed amount (~0.2 s at
// 20 Hz, omega0 = 6).

import { rfft, fftInPlace } from './fft.js';

export class MorletCWT {
  /**
   * @param {object} opts
   * @param {number} opts.fullSize full-rate block length (power of 2)
   * @param {number} opts.sampleRate full sample rate
   * @param {number} opts.fMin lowest centre frequency (Hz)
   * @param {number} opts.fMax highest centre frequency (Hz)
   * @param {number} opts.binsPerOctave scales per octave
   * @param {number} opts.omega0 Morlet parameter (~Q); 6 is classic
   */
  constructor({
    fullSize = 32768,
    sampleRate = 48000,
    fMin = 20,
    fMax = 5000,
    binsPerOctave = 12,
    omega0 = 6,
  } = {}) {
    if ((fullSize & (fullSize - 1)) !== 0) throw new Error('fullSize must be a power of 2');
    this.fullSize = fullSize;
    this.sampleRate = sampleRate;
    this.omega0 = omega0;

    // Decimation factor: keep decimated Nyquist comfortably above fMax
    let D = 1;
    while (sampleRate / (2 * D * 2) >= fMax * 1.25 && fullSize / (D * 2) >= 1024) D *= 2;
    this.decimation = D;
    this.decSize = fullSize / D;         // complex IFFT size
    this.decRate = sampleRate / D;       // decimated sample rate

    // Scale centre frequencies, geometric from fMin to fMax
    const nOct = Math.log2(fMax / fMin);
    const nScales = Math.max(2, Math.round(nOct * binsPerOctave) + 1);
    this.freqs = new Float64Array(nScales);
    for (let j = 0; j < nScales; j++) {
      this.freqs[j] = fMin * 2 ** ((j * nOct) / (nScales - 1));
    }
    this.nScales = nScales;

    // Latency: 4 sigma of the lowest-frequency wavelet, in decimated samples.
    // Morlet time sigma at frequency f is s = omega0 / (2 pi f).
    const sigmaMax = omega0 / (2 * Math.PI * fMin);
    this.latencyDec = Math.ceil(4 * sigmaMax * this.decRate);
    if (this.latencyDec > this.decSize / 2) {
      throw new Error(
        `Block too short for fMin=${fMin} Hz: latency ${this.latencyDec} > ${this.decSize / 2}`
      );
    }

    // Precompute filters: H_j[k] = 2 * exp(-(s_j*w_k - omega0)^2 / 2)
    // on decimated bins k = 0..decSize/2 (positive frequencies only).
    const nBins = this.decSize / 2 + 1;
    this.filters = [];
    for (let j = 0; j < nScales; j++) {
      const s = omega0 / (2 * Math.PI * this.freqs[j]);
      const H = new Float64Array(nBins);
      for (let k = 0; k < nBins; k++) {
        const w = (2 * Math.PI * k * this.decRate) / this.decSize; // rad/s
        const arg = s * w - omega0;
        const g = Math.exp(-0.5 * arg * arg);
        H[k] = k === 0 || k === nBins - 1 ? g : 2 * g;
      }
      this.filters.push(H);
    }

    this.re = new Float64Array(this.decSize);
    this.im = new Float64Array(this.decSize);
  }

  /** Seconds by which output trails the newest sample. */
  get latencySeconds() {
    return this.latencyDec / this.decRate;
  }

  /**
   * Compute the newest `nCols` scaleogram columns.
   * Column c (0-based, oldest first) corresponds to decimated time index
   * decSize - 1 - latencyDec - (nCols - 1 - c) * colStride.
   *
   * @param {Float32Array} samples newest fullSize full-rate samples
   * @param {number} nCols number of output columns
   * @param {number} colStride decimated samples per column
   * @param {Float32Array} [out] length nScales * nCols, row-major by scale
   * @returns {Float32Array} amplitudes |y| (linear, full-scale units)
   */
  analyze(samples, nCols, colStride, out = null) {
    const M = this.fullSize;
    if (samples.length < M) throw new Error('need fullSize samples');
    const block = samples.length === M ? samples : samples.subarray(samples.length - M);

    const spec = rfft(block); // one-sided, M/2+1 bins
    const nBins = this.decSize / 2 + 1;
    const result = out ?? new Float32Array(this.nScales * nCols);

    const newest = this.decSize - 1 - this.latencyDec;
    const oldestNeeded = newest - (nCols - 1) * colStride;
    if (oldestNeeded < 0) throw new Error('too many columns for block length');

    for (let j = 0; j < this.nScales; j++) {
      const H = this.filters[j];
      const re = this.re;
      const im = this.im;
      re.fill(0);
      im.fill(0);
      for (let k = 0; k < nBins; k++) {
        re[k] = spec.re[k] * H[k];
        im[k] = spec.im[k] * H[k];
      }
      // Inverse FFT is unscaled. A tone of amplitude A at a scale centre has
      // |X_full| = A/2 * fullSize in its bin; the doubled filter and a 1/fullSize
      // normalisation make |y| read A directly.
      fftInPlace(re, im, true);
      const norm = 1 / this.fullSize;
      for (let c = 0; c < nCols; c++) {
        const t = oldestNeeded + c * colStride;
        result[j * nCols + c] = Math.hypot(re[t], im[t]) * norm;
      }
    }
    return result;
  }
}
