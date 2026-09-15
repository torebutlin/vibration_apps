// Streaming continuous wavelet transform (Morlet) for a live scaleogram.
//
// The signal is anti-alias filtered and decimated to a rate a little above
// 2.5 x fMax, then each output column is the direct correlation of the
// decimated stream with every scale's complex wavelet, evaluated at that
// column's instant only. Cost is therefore proportional to the number of
// columns (not to the block length), and columns arrive on the audio clock
// one hop at a time — nothing to batch, nothing to catch up on.
//
// Latency is per scale, not global. A wavelet centred at t spans t +- 4
// sigma, so scale j cannot be evaluated until 4 sigma_j of signal has
// arrived after its instant. sigma_j falls as 1/f, so the treble is ready
// almost at once and the bottom of the band trails by a long way; a caller
// that gates everything on the widest wavelet throws away the freshness of
// every other row. Columns are therefore addressed on one clock — the head
// index — with each scale reading the column `lagCols[j]` behind it.
//
// Amplitude: a tone of amplitude A at a scale's centre frequency reads A
// on that row (each wavelet is normalised by its own response to one).

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

/** How the wavelet's bandwidth follows its centre frequency. */
export const BANDWIDTH_LAWS = ['constq', 'ear'];

/**
 * Equivalent rectangular bandwidth of the human auditory filter centred at
 * f, in Hz (Glasberg & Moore 1990):
 *
 *   ERB(f) = 24.7 (4.37 f / 1000 + 1)
 *
 * It tends to f/9.3 in the treble but flattens to about 25 Hz at the bottom
 * of the range, so hearing gives up frequency resolution down there and
 * buys time resolution with it. That is why a clap with bass content is
 * heard as one event, where a constant-Q analysis smears it over most of a
 * second.
 */
export function erbHz(f) {
  return 24.7 * (4.37e-3 * f + 1);
}

/**
 * Gaussian bandwidth sigma_f (Hz) of the wavelet at centre frequency f.
 * - constq: the Morlet's own, sigma_f = f / omega0 — self-similar, so the
 *   transform is a wavelet transform proper.
 * - ear: the width whose equivalent rectangular bandwidth matches the
 *   auditory filter, ERB = sigma_f sqrt(2 pi). Not self-similar, so this is
 *   a filterbank rather than a wavelet transform, and its scales run from
 *   about 2 cycles at the bottom of the audible range to 20 at the top.
 */
export function sigmaFHz(f, bandwidth = 'constq', omega0 = 12) {
  return bandwidth === 'ear' ? erbHz(f) / Math.sqrt(2 * Math.PI) : f / omega0;
}

export class StreamingCWT {
  /**
   * @param {object} opts
   * @param {number} opts.sampleRate full sample rate
   * @param {number} opts.fMin lowest centre frequency (Hz)
   * @param {number} opts.fMax highest centre frequency (Hz)
   * @param {number} opts.binsPerOctave scales per octave
   * @param {number} opts.omega0 Morlet parameter (~Q); 6 is classic
   * @param {'constq'|'ear'} opts.bandwidth how bandwidth follows frequency
   * @param {number} opts.hopSamples wanted full-rate samples per column
   *   (rounded to a whole number of decimated samples; see .hop)
   */
  constructor({
    sampleRate = 48000,
    fMin = 30,
    fMax = 4000,
    binsPerOctave = 16,
    omega0 = 12,
    bandwidth = 'constq',
    hopSamples = 480,
  } = {}) {
    this.sampleRate = sampleRate;
    this.omega0 = omega0;
    this.bandwidth = BANDWIDTH_LAWS.includes(bandwidth) ? bandwidth : 'constq';

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
    // 1 / (2 pi sigma_f) seconds, truncated at 4 sigma each side.
    this.half = new Int32Array(nScales);
    this.lagCols = new Int32Array(nScales);
    this.lagSeconds = new Float64Array(nScales);
    this.cosT = new Array(nScales);
    this.sinT = new Array(nScales);
    this.norm = new Float64Array(nScales);
    let Lmax = 0;
    for (let j = 0; j < nScales; j++) {
      const f = this.freqs[j];
      const sigma = this.decRate / (2 * Math.PI * sigmaFHz(f, this.bandwidth, omega0));
      const L = Math.ceil(4 * sigma);
      const c = new Float32Array(2 * L + 1);
      const s = new Float32Array(2 * L + 1);
      const g = new Float64Array(2 * L + 1);
      const w = (2 * Math.PI * f) / this.decRate;
      let sumG = 0;
      let sumC = 0;
      for (let n = -L; n <= L; n++) {
        const e = Math.exp(-(n * n) / (2 * sigma * sigma));
        g[n + L] = e;
        sumG += e;
        sumC += e * Math.cos(w * n);
      }
      // Zero-mean (admissible) Morlet: subtract the envelope's own response
      // at DC. Negligible for omega0 >= 6, but the auditory law puts barely
      // two cycles under the envelope at the bottom of the band, where an
      // uncorrected wavelet would answer to DC and to slow drift.
      const k = sumC / sumG;
      for (let n = -L; n <= L; n++) {
        c[n + L] = g[n + L] * (Math.cos(w * n) - k);
        s[n + L] = g[n + L] * Math.sin(w * n);
      }
      // Amplitude calibration, measured rather than assumed: a unit cosine
      // at the centre frequency must read 1 on this row.
      let re = 0;
      let im = 0;
      for (let n = -L; n <= L; n++) {
        const x = Math.cos(w * n);
        re += x * c[n + L];
        im += x * s[n + L];
      }
      this.half[j] = L;
      this.cosT[j] = c;
      this.sinT[j] = s;
      this.norm[j] = 1 / Math.hypot(re, im);
      // whole columns of lag, so every scale advances on the one clock
      this.lagCols[j] = Math.ceil(L / this.hopDec);
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

    // Per-scale latency, and the worst of them (what the ring must hold)
    this.minLagCols = this.lagCols[0];
    this.maxLagCols = this.lagCols[0];
    for (let j = 0; j < nScales; j++) {
      const lag = this.lagCols[j];
      if (lag < this.minLagCols) this.minLagCols = lag;
      if (lag > this.maxLagCols) this.maxLagCols = lag;
      this.lagSeconds[j] = (lag * this.hop + this.groupDelay) / sampleRate;
    }
    this.minLagSeconds = (this.minLagCols * this.hop + this.groupDelay) / sampleRate;
    this.maxLagSeconds = (this.maxLagCols * this.hop + this.groupDelay) / sampleRate;
    this.latencySamples = Lmax * D + this.groupDelay;
    this.latencySeconds = this.latencySamples / sampleRate;

    // Decimated ring: both halves of the widest wavelet plus a backlog
    let cap = 1024;
    while (cap < 2 * Lmax + 32 * this.hopDec + 1024) cap <<= 1;
    this.ring = new Float32Array(cap);
    this.mask = cap - 1;
    this.ringSeconds = cap / this.decRate; // how much backlog a push may carry
    this.decCount = 0;    // decimated samples produced so far
    this.pushed = 0;      // full-rate samples pushed so far
    this.nextOut = 0;     // next decimated output index (i = m * D)
    // First head at which every scale has a whole window: its own column
    // sits maxLag behind, and that column needs maxLag of signal before it.
    this.nextHead = 2 * this.maxLagCols;
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

  /** The column clock: the newest column index whose instant has passed.
   *  Scale j is computable at column `head - lagCols[j]`. */
  get head() {
    return Math.floor((this.decCount - 1) / this.hopDec);
  }

  /** Heads that can be emitted now. */
  get pending() {
    return Math.max(0, this.head - this.nextHead + 1);
  }

  /** Full-rate stream position (samples since the first push) of a column. */
  totalAt(col) {
    return col * this.hop - this.groupDelay;
  }

  /**
   * Compute the next head: every scale's value at its own column, which is
   * `head - lagCols[j]`, into `out` (length nScales, amplitudes).
   * @returns {number|null} the head index, or null if none is ready. Heads
   *   advance by one unless the ring overflowed, in which case the next one
   *   jumps forward.
   */
  nextColumn(out) {
    if (this.pending <= 0) return null;
    let h = this.#usableHead(this.nextHead);
    for (let j = 0; j < this.nScales; j++) out[j] = this.#value(j, h - this.lagCols[j]);
    this.nextHead = h + 1;
    return h;
  }

  /** Advance past the next head without computing it (slow devices). */
  skipColumn() {
    if (this.pending <= 0) return null;
    const h = this.#usableHead(this.nextHead);
    this.nextHead = h + 1;
    return h;
  }

  /** The first head at or after `h` whose oldest sample is still in the
   *  ring — after a stall the stream jumps forward rather than reading
   *  samples that have been overwritten. */
  #usableHead(h) {
    const oldest = this.decCount - this.ring.length;
    const need = (h - this.maxLagCols) * this.hopDec - this.latencyDec;
    if (need >= oldest) return h;
    const short = oldest - need;
    return h + Math.ceil(short / this.hopDec);
  }

  #value(j, col) {
    const t = col * this.hopDec;
    const ring = this.ring;
    const mask = this.mask;
    const cap = ring.length;
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
    return Math.hypot(re, im) * this.norm[j];
  }
}
