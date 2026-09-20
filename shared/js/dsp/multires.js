// Multi-resolution "smart" spectrum: three stitched FFT lengths so low
// frequencies get proportionally longer windows (finer resolution) while
// high frequencies stay responsive.
//
// Stage sizes are N, 4N, 16N samples at the full sample rate. Stage k
// covers frequencies up to (fs/2)/4^k, so every region spans the same
// range of relative resolution: df/f = 2/N at the top of a region and 8/N
// at its bottom. At each boundary the resolution jumps by 4x (the dashed
// lines in the display); the echo lines carry each stage past its boundary
// so the eye can follow the level across the jump.
//
// Each stage has its own window correction, averaging state and peak hold.
// Averaging modes mirror SpectrumProcessor (off / exponential / a moving
// average of the last N independent frames).
//
// How often a stage is recomputed is a display question, not an averaging
// one. A stage could wait for half its window of new samples — 50% overlap,
// the cheapest frame that is worth averaging — but that leaves the bottom
// region redrawing 4^k times more slowly than the top, which reads as a
// stutter rather than as resolution. So a stage is recomputed as often as
// the device can afford, up to once per frame, and the averaging is told
// how much new data the frame carried rather than assuming one frame's
// worth: the extra recomputes overlap more, which costs arithmetic, not
// accuracy. "16 averages" therefore means the same thing at any cadence.

import { rfftMagSq } from './fft.js';
import { getWindow } from './windows.js';
import { RollingPowerAverage } from './rolling.js';

// Longest exponential averaging time any stage will use (seconds). See
// #stageTau: without a cap the lowest region would average over 8 s at the
// default 0.5 s setting, which is longer than a demo holds still.
const MAX_STAGE_TAU = 4;

// Share of real time the three stages may spend between them. A 16x FFT
// every frame is affordable on a laptop and not on a phone, so the cadence
// follows what the stages measurably cost here.
const CADENCE_BUDGET = 0.35;

/**
 * How often each stage may be recomputed, in frames.
 *
 * Every stage would ideally run every frame. Where that does not fit the
 * budget a stage falls back through powers of two, and never past the
 * `max` it is given — the cadence the display had before any of this, so a
 * slow device is left no worse off than it was.
 *
 * @param {number[]} costMs measured cost of one recompute per stage
 * @param {number} hopSeconds real time each frame covers
 * @param {number[]} max coarsest cadence allowed per stage
 * @param {number} budget share of real time for all stages together
 * @returns {number[]} cadence per stage
 */
export function chooseCadences(costMs, hopSeconds, max, budget = CADENCE_BUDGET) {
  const out = [];
  let used = 0;
  for (let k = 0; k < costMs.length; k++) {
    const share = (cadence) => costMs[k] / 1000 / (hopSeconds * cadence);
    let cadence = 1;
    while (cadence < max[k] && used + share(cadence) > budget) cadence *= 2;
    out.push(cadence);
    used += share(cadence);
  }
  return out;
}

export class MultiResSpectrum {
  /**
   * @param {object} opts
   * @param {number} opts.baseSize FFT size of the fastest (highest-frequency) stage
   * @param {string} opts.windowName
   * @param {number} opts.sampleRate
   */
  constructor({ baseSize = 4096, windowName = 'hann', sampleRate = 48000 } = {}) {
    this.sampleRate = sampleRate;
    this.expTimeConst = 0.5;
    this.avgMode = 'exponential';
    this.linearTarget = 16;
    // 0 pins every stage at its coarsest cadence (tests, and for measuring
    // against the display this replaced)
    this.cadenceBudget = CADENCE_BUDGET;
    this.hopSeconds = 0;
    this.configure(baseSize, windowName);
  }

  configure(baseSize, windowName) {
    this.baseSize = baseSize;
    this.windowName = windowName;
    this.stages = [0, 1, 2].map((k) => {
      const size = baseSize * 4 ** k;
      const { w, coherentGain, noiseGain } = getWindow(windowName, size);
      const nBins = size / 2 + 1;
      return {
        size,
        w,
        coherentGain,
        noiseGain,
        nBins,
        // recompute every `cadence` frames; 2^k is where it starts and the
        // coarsest it will go (see chooseCadences)
        cadence: 2 ** k,
        maxCadence: 2 ** k,
        cost: 0,               // ms per recompute, smoothed
        pendingWeight: 0,      // base frames of new data since it last ran
        pendingDt: 0,          // and how long ago that was
        frame: 0,
        windowed: new Float64Array(size),
        power: new Float64Array(nBins),
        avgPower: new Float64Array(nBins),
        peakPower: new Float64Array(nBins),
        avgCount: 0,
        rolling: null,         // moving window, built only in linear mode
        // Region covered by this stage: (fLow, fHigh]; stage 2 reaches 0
        fHigh: this.sampleRate / 2 / 4 ** k,
        fLow: k === 2 ? 0 : this.sampleRate / 2 / 4 ** (k + 1),
      };
    });
    this.#configureRolling();
    this.resetAverage();
    this.resetPeakHold();
  }

  setAveraging(mode, { expTimeConst, linearTarget } = {}) {
    this.avgMode = mode;
    if (expTimeConst !== undefined) this.expTimeConst = expTimeConst;
    if (linearTarget !== undefined) this.linearTarget = linearTarget;
    this.#configureRolling();
    this.resetAverage();
  }

  /** A moving window per stage, built only while it is the mode in use:
   *  the lowest stage's spectra are the longest and there are N of them. */
  #configureRolling() {
    for (const s of this.stages) {
      s.rolling = this.avgMode === 'linear'
        ? new RollingPowerAverage(s.nBins, this.linearTarget)
        : null;
    }
  }

  resetAverage() {
    for (const s of this.stages) {
      s.avgPower.fill(0);
      s.avgCount = 0;
      s.pendingWeight = 0;
      s.pendingDt = 0;
      s.rolling?.reset();
    }
  }

  resetPeakHold() {
    for (const s of this.stages) s.peakPower.fill(0);
    this.peakValid = false;
  }

  /**
   * Exponential averaging time for stage k. A stage's window is 4^k longer,
   * so in a given number of seconds it sees 4^k fewer independent frames:
   * averaging every stage over the same time leaves the long ones barely
   * averaged at all, and the low end of the trace comes out about three
   * times noisier than the top (measurably: 2.9 dB of scatter against
   * 0.9 dB). Scaling the time constant with the window equalises the noise
   * across the stitched regions. The instantaneous trace is unaffected, so
   * the display still responds immediately.
   * @param {number} k stage index
   */
  #stageTau(k) {
    return Math.min(this.expTimeConst * 4 ** k, MAX_STAGE_TAU);
  }

  /** How full the slowest stage's window is (linear mode): {count, target,
   *  done} — done once every region spans its full number of averages. */
  get linearProgress() {
    let count = Infinity;
    let done = true;
    for (const s of this.stages) {
      count = Math.min(count, s.avgCount);
      if (!s.rolling?.full) done = false;
    }
    return { count, target: this.linearTarget, done };
  }

  /** Longest window length needed from the ring buffer. */
  get maxSize() {
    return this.stages[2].size;
  }

  /**
   * @param {Float32Array} samples newest samples, length >= maxSize
   * @param {number} dt seconds since last call
   * @param {number} weight independent-frame weight of this call for the
   *   base stage (1 = hop of half the base window). Each stage banks these
   *   until it next runs: the data it then sees is worth that much divided
   *   by 4^k, its window being that much longer, however often it ran.
   */
  process(samples, dt, weight = 1) {
    // Real time each call covers, from the audio rather than the clock: a
    // display that has fallen behind reports a longer dt, which would make
    // the work look cheaper the slower it got.
    if (weight > 0) this.hopSeconds = (weight * this.baseSize) / (2 * this.sampleRate);
    for (let k = 0; k < this.stages.length; k++) {
      const s = this.stages[k];
      s.frame++;
      s.pendingWeight += weight;
      s.pendingDt += dt;
      if (s.frame % s.cadence !== 0 && s.avgCount > 0) continue;
      const startedAt = performance.now();
      const n = s.size;
      const offset = samples.length - n;
      for (let i = 0; i < n; i++) s.windowed[i] = samples[offset + i] * s.w[i];
      rfftMagSq(s.windowed, s.power);
      {
        const { power, avgPower, nBins } = s;
        switch (this.avgMode) {
          case 'off':
            avgPower.set(power);
            s.avgCount = 1;
            break;
          case 'linear': {
            // the new data since this stage last ran, in its own frames
            s.rolling.add(power, s.pendingWeight / 4 ** k);
            s.rolling.writeTo(avgPower);
            s.avgCount = s.rolling.frames;
            break;
          }
          default: {
            const alpha = s.avgCount === 0
              ? 1
              : 1 - Math.exp(-s.pendingDt / Math.max(this.#stageTau(k), 1e-3));
            for (let b = 0; b < nBins; b++) avgPower[b] += alpha * (power[b] - avgPower[b]);
            s.avgCount++;
          }
        }
      }
      s.pendingWeight = 0;
      s.pendingDt = 0;
      const { avgPower, peakPower, nBins } = s;
      for (let b = 0; b < nBins; b++) if (avgPower[b] > peakPower[b]) peakPower[b] = avgPower[b];
      const took = performance.now() - startedAt;
      s.cost = s.cost ? s.cost + 0.25 * (took - s.cost) : took;
    }
    this.peakValid = true;
    this.#chooseCadences();
  }

  /** Re-fit the cadences to what the stages are measurably costing. */
  #chooseCadences() {
    if (!this.cadenceBudget) {
      for (const s of this.stages) s.cadence = s.maxCadence;
      return;
    }
    if (!this.hopSeconds) return;
    if (this.stages.some((s) => !s.cost)) return; // not all measured yet
    const cadences = chooseCadences(
      this.stages.map((s) => s.cost),
      this.hopSeconds,
      this.stages.map((s) => s.maxCadence),
      this.cadenceBudget
    );
    for (let k = 0; k < this.stages.length; k++) this.stages[k].cadence = cadences[k];
  }

  #sourceArray(s, source) {
    return source === 'peak' ? s.peakPower : source === 'inst' ? s.power : s.avgPower;
  }

  #convertRange(s, powerArr, startBin, endBin, quantity, dB) {
    const fs = this.sampleRate;
    const values = new Float32Array(endBin - startBin + 1);
    const cAmp = 2 / (s.size * s.coherentGain);
    const psdScale = 2 / (fs * s.size * s.noiseGain);
    const rms = quantity === 'rms';
    for (let b = startBin; b <= endBin; b++) {
      const edge = b === 0 || b === s.nBins - 1;
      let v;
      if (quantity === 'psd') {
        v = powerArr[b] * psdScale;
        if (edge) v /= 2;
        values[b - startBin] = dB ? 10 * Math.log10(Math.max(v, 1e-30)) : v;
      } else {
        v = cAmp * Math.sqrt(Math.max(powerArr[b], 0));
        if (edge) v /= 2;
        else if (rms) v /= Math.SQRT2;
        values[b - startBin] = dB ? 20 * Math.log10(Math.max(v, 1e-15)) : v;
      }
    }
    return values;
  }

  /**
   * Stitched display segments, low frequency first. Each segment holds the
   * bins of one stage that fall inside its region, converted like
   * SpectrumProcessor.toDisplay.
   * @param {'amplitude'|'rms'|'psd'} quantity
   * @param {boolean} dB
   * @param {'avg'|'peak'|'inst'} source which power spectrum to convert
   * @returns {{binHz: number, startBin: number, values: Float32Array, fLow: number, fHigh: number}[]}
   */
  segments(quantity, dB, source = 'avg') {
    const fs = this.sampleRate;
    const out = [];
    for (let k = 2; k >= 0; k--) {
      const s = this.stages[k];
      const powerArr = this.#sourceArray(s, source);
      const binHz = fs / s.size;
      const startBin = k === 2 ? 0 : Math.ceil(s.fLow / binHz);
      const endBin = Math.min(Math.floor(s.fHigh / binHz), s.nBins - 1);
      out.push({
        binHz,
        startBin,
        values: this.#convertRange(s, powerArr, startBin, endBin, quantity, dB),
        fLow: s.fLow,
        fHigh: s.fHigh,
      });
    }
    return out;
  }

  /**
   * Echo segments: each stage's estimate continued a little way past its
   * region boundary (every stage is a full-band FFT, so the data exists) —
   * drawn faded to guide the eye across the resolution discontinuities.
   * fadeFromHz/fadeToHz give the fade direction (boundary -> vanishing).
   * @param {number} factor how far past the boundary, in frequency ratio
   */
  extensions(quantity, dB, factor = 1.6, source = 'avg') {
    const fs = this.sampleRate;
    const out = [];
    for (let k = 2; k >= 0; k--) {
      const s = this.stages[k];
      const powerArr = this.#sourceArray(s, source);
      const binHz = fs / s.size;
      if (k >= 1) {
        // continue upward past fHigh
        const from = Math.ceil(s.fHigh / binHz);
        const to = Math.min(Math.floor((s.fHigh * factor) / binHz), s.nBins - 1);
        if (to >= from) {
          out.push({
            binHz,
            startBin: from,
            values: this.#convertRange(s, powerArr, from, to, quantity, dB),
            fadeFromHz: s.fHigh,
            fadeToHz: s.fHigh * factor,
          });
        }
      }
      if (k <= 1) {
        // continue downward past fLow
        const from = Math.max(Math.ceil(s.fLow / factor / binHz), 1);
        const to = Math.floor(s.fLow / binHz);
        if (to >= from) {
          out.push({
            binHz,
            startBin: from,
            values: this.#convertRange(s, powerArr, from, to, quantity, dB),
            fadeFromHz: s.fLow,
            fadeToHz: s.fLow / factor,
          });
        }
      }
    }
    return out;
  }
}
