// Streaming continuous wavelet transform (Morlet) for a live scaleogram.
//
// The signal is anti-alias filtered and decimated to a rate a little above
// 2.5 x fMax, then each output column is the direct correlation of the
// decimated stream with every scale's complex Morlet wavelet, evaluated at
// that column's instant only. Cost is therefore proportional to the number
// of columns (not to the block length), the latency is fixed at four sigma
// of the widest wavelet, and columns arrive on the audio clock one hop at
// a time — nothing to batch, nothing to catch up on.
//
// Amplitude: a tone of amplitude A at a scale's centre frequency reads A
// on that row (the wavelet is normalised by half the envelope sum).

/** Blackman-windowed sinc low-pass, normalised to unit DC gain. */
function lowpass(taps, fcNorm) {
  const h = new Float32Array(taps);
  const M = (taps - 1) / 2;
  let sum = 0;
  for (let k = 0; k < taps; k++) {
    const n = k - M;
    const sinc = n === 0 ? 2 * fcNorm : Math.sin(2 * Math.PI * fcNorm * n) / (Math.PI * n);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * k) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * k) / (taps - 1));
    h[k] = sinc * w;
    sum += h[k];
  }
  for (let k = 0; k < taps; k++) h[k] /= sum;
  return h;
}

export class StreamingCWT {
  /**
   * @param {object} opts
   * @param {number} opts.sampleRate full sample rate
   * @param {number} opts.fMin lowest centre frequency (Hz)
   * @param {number} opts.fMax highest centre frequency (Hz)
   * @param {number} opts.binsPerOctave scales per octave
   * @param {number} opts.omega0 Morlet parameter (~Q); 6 is classic
   * @param {number} opts.hopSamples wanted full-rate samples per column
   *   (rounded to a whole number of decimated samples; see .hop)
   */
  constructor({
    sampleRate = 48000,
    fMin = 30,
    fMax = 4000,
    binsPerOctave = 16,
    omega0 = 12,
    hopSamples = 480,
  } = {}) {
    this.sampleRate = sampleRate;
    this.omega0 = omega0;

    // Decimation: keep the decimated Nyquist at least 1.25 x fMax
    let D = 1;
    while (sampleRate / (2 * D * 2) >= fMax * 1.25) D *= 2;
    this.decimation = D;
    this.decRate = sampleRate / D;
    this.hopDec = Math.max(1, Math.round(hopSamples / D));
    this.hop = this.hopDec * D;

    // Scale centre frequencies, geometric from fMin to fMax
    const nOct = Math.log2(fMax / fMin);
    const nScales = Math.max(2, Math.round(nOct * binsPerOctave) + 1);
    this.freqs = new Float64Array(nScales);
    for (let j = 0; j < nScales; j++) this.freqs[j] = fMin * 2 ** ((j * nOct) / (nScales - 1));
    this.nScales = nScales;

    // Wavelets on the decimated grid: Gaussian envelope of sigma =
    // omega0 / (2 pi f) seconds, truncated at 4 sigma each side.
    this.half = new Int32Array(nScales);
    this.cosT = new Array(nScales);
    this.sinT = new Array(nScales);
    this.norm = new Float64Array(nScales);
    let Lmax = 0;
    for (let j = 0; j < nScales; j++) {
      const f = this.freqs[j];
      const sigma = (omega0 / (2 * Math.PI * f)) * this.decRate;
      const L = Math.ceil(4 * sigma);
      const c = new Float32Array(2 * L + 1);
      const s = new Float32Array(2 * L + 1);
      const w = (2 * Math.PI * f) / this.decRate;
      let sumG = 0;
      for (let n = -L; n <= L; n++) {
        const g = Math.exp(-(n * n) / (2 * sigma * sigma));
        c[n + L] = g * Math.cos(w * n);
        s[n + L] = g * Math.sin(w * n);
        sumG += g;
      }
      this.half[j] = L;
      this.cosT[j] = c;
      this.sinT[j] = s;
      this.norm[j] = 2 / sumG;
      if (L > Lmax) Lmax = L;
    }
    this.latencyDec = Lmax;

    // Anti-alias decimator: passband to fMax, stopband from decRate - fMax
    // (what would fold back into the band), Blackman sinc. Only evaluated
    // at decimated instants, so even thousands of taps are cheap.
    if (D > 1) {
      const tw = this.decRate - 2 * fMax;
      const taps = Math.min(4095, Math.ceil((5.5 * sampleRate) / tw)) | 1;
      this.h = lowpass(taps, this.decRate / 2 / sampleRate);
      this.taps = taps;
      this.carry = new Float32Array(taps - 1);
      this.work = new Float32Array(taps - 1 + 8192);
    } else {
      this.taps = 1;
      this.carry = new Float32Array(0);
      this.work = null;
    }
    this.groupDelay = (this.taps - 1) / 2; // full-rate samples
    this.latencySamples = Lmax * D + this.groupDelay;
    this.latencySeconds = this.latencySamples / sampleRate;

    // Decimated ring: both halves of the widest wavelet plus a backlog
    let cap = 1024;
    while (cap < 2 * Lmax + 32 * this.hopDec + 1024) cap <<= 1;
    this.ring = new Float32Array(cap);
    this.mask = cap - 1;
    this.decCount = 0;    // decimated samples produced so far
    this.pushed = 0;      // full-rate samples pushed so far
    this.nextOut = 0;     // next decimated output index (i = m * D)
    this.nextColDec = Lmax; // decimated index of the next column instant
  }

  /** Append full-rate samples to the stream. */
  push(chunk) {
    const D = this.decimation;
    const ring = this.ring;
    const mask = this.mask;
    if (D === 1) {
      for (let i = 0; i < chunk.length; i++) ring[(this.decCount + i) & mask] = chunk[i];
      this.decCount += chunk.length;
      this.pushed += chunk.length;
      return;
    }
    const T = this.taps;
    const C = T - 1;
    if (this.work.length < C + chunk.length) this.work = new Float32Array(C + chunk.length);
    const work = this.work;
    work.set(this.carry, 0);
    work.set(chunk, C);
    const base = this.pushed - C; // global full-rate index of work[0]
    const end = this.pushed + chunk.length;
    const h = this.h;
    let m = this.nextOut;
    while (m * D <= end - 1) {
      const off = m * D - base;
      let acc = 0;
      for (let k = 0; k < T; k++) acc += h[k] * work[off - k];
      ring[this.decCount & mask] = acc;
      this.decCount++;
      m++;
    }
    this.nextOut = m;
    const len = end - base;
    this.carry.set(work.subarray(len - C, len));
    this.pushed = end;
  }

  /** Columns that can be computed now (their whole window has arrived). */
  get available() {
    const lastT = this.decCount - 1 - this.latencyDec;
    if (lastT < this.nextColDec) return 0;
    return Math.floor((lastT - this.nextColDec) / this.hopDec) + 1;
  }

  /**
   * Compute the next column into `out` (length nScales, amplitudes).
   * @returns {number|null} the column's instant as a full-rate stream
   *   position (samples since the first push), or null if none is ready.
   *   Instants advance by exactly `hop` unless the ring overflowed, in
   *   which case the next instant jumps forward by whole hops.
   */
  nextColumn(out) {
    if (this.available === 0) return null;
    let t = this.nextColDec;
    const oldest = this.decCount - this.ring.length;
    if (t - this.latencyDec < oldest) {
      // fell behind by more than the ring holds: jump to the oldest computable column
      const jump = Math.ceil((oldest + this.latencyDec - t) / this.hopDec);
      t += jump * this.hopDec;
    }
    this.#column(t, out);
    this.nextColDec = t + this.hopDec;
    return t * this.decimation - this.groupDelay;
  }

  /** Advance past the next column without computing it (slow devices). */
  skipColumn() {
    if (this.available === 0) return null;
    const t = this.nextColDec;
    this.nextColDec = t + this.hopDec;
    return t * this.decimation - this.groupDelay;
  }

  #column(t, out) {
    const ring = this.ring;
    const mask = this.mask;
    const cap = ring.length;
    for (let j = 0; j < this.nScales; j++) {
      const L = this.half[j];
      const c = this.cosT[j];
      const s = this.sinT[j];
      const n = 2 * L + 1;
      const start = (t - L) & mask;
      let re = 0;
      let im = 0;
      if (start + n <= cap) {
        for (let i = 0; i < n; i++) {
          const x = ring[start + i];
          re += x * c[i];
          im += x * s[i];
        }
      } else {
        for (let i = 0; i < n; i++) {
          const x = ring[(start + i) & mask];
          re += x * c[i];
          im += x * s[i];
        }
      }
      out[j] = Math.hypot(re, im) * this.norm[j];
    }
  }
}
