// Auto-scaling for a plot's amplitude axis: where each limit should sit
// (levelStats) and how it is allowed to move (AxisLimit).
//
// Both halves exist to keep a live display readable. An axis fitted to the
// instantaneous extremes of the data jitters at frame rate and, on a
// spectrum, sits far below anything worth looking at: a single periodogram
// bin is exponentially distributed, so its deepest dips run tens of dB
// below the mean. levelStats therefore answers with a low quantile rather
// than the minimum, and AxisLimit gives ground back slowly.

/**
 * Level statistics of a set of trace segments over a band of the x axis:
 * the peak, and the level that all but `tail` of the samples sit above.
 *
 * Values are assumed to be in dB (the quantile uses 1-unit buckets).
 * Segments are `{binHz, startBin, values}` — the same shape the spectrum
 * traces are drawn from.
 *
 * @param {{binHz: number, startBin: number, values: ArrayLike<number>}[]} segments
 * @param {number} xMin low edge of the band, in the same units as binHz
 * @param {number} xMax high edge
 * @param {object} [opts]
 * @param {number} [opts.tail] fraction of samples allowed below `low`
 * @param {number} [opts.depth] how far below the peak the quantile can reach
 * @param {boolean} [opts.floor] false skips the quantile (`low` comes back
 *   as the peak) for callers that only scale the top of the axis
 * @param {Int32Array} [opts.hist] scratch histogram of length >= depth,
 *   to keep the per-frame allocation out of the render loop
 * @returns {{peak: number, low: number, count: number}|null} null when the
 *   band holds no samples
 */
export function levelStats(segments, xMin, xMax, { tail = 0.02, depth = 160, floor = true, hist } = {}) {
  let peak = -Infinity;
  let count = 0;
  for (const seg of segments) {
    for (let i = 0; i < seg.values.length; i++) {
      const x = (seg.startBin + i) * seg.binHz;
      if (x < xMin || x > xMax) continue;
      count++;
      if (seg.values[i] > peak) peak = seg.values[i];
    }
  }
  if (!count || !Number.isFinite(peak)) return null;
  if (!floor) return { peak, low: peak, count };

  const h = hist && hist.length >= depth ? hist : new Int32Array(depth);
  h.fill(0, 0, depth);
  for (const seg of segments) {
    for (let i = 0; i < seg.values.length; i++) {
      const x = (seg.startBin + i) * seg.binHz;
      if (x < xMin || x > xMax) continue;
      const d = Math.floor(peak - seg.values[i]);
      h[d < 0 ? 0 : d >= depth ? depth - 1 : d]++;
    }
  }
  const want = count * (1 - tail);
  let seen = 0;
  let d = 0;
  for (; d < depth - 1; d++) {
    seen += h[d];
    if (seen >= want) break;
  }
  return { peak, low: peak - (d + 1), count };
}

/**
 * One end of an auto-scaled axis, with attack / hold / release:
 *  - never clip: move straight to `required` when it lies outside the limit;
 *  - hold while the data stays within `holdBand` of the limit;
 *  - after `holdMs` inside that, settle back with time constant `tau`, so
 *    the data refills the plot without the axis jumping around.
 *
 * The dead band decides when a release *starts*; once it has, the limit
 * glides all the way in, so a stationary signal ends up filling the plot
 * rather than stopping a dead band short of it.
 */
export class AxisLimit {
  /**
   * @param {number} value starting position
   * @param {1|-1} dir +1 for a ceiling, -1 for a floor — which way is "out"
   * @param {object} [opts] { holdBand, holdMs, tau } (dB, ms, seconds)
   */
  constructor(value, dir, { holdBand = 12, holdMs = 1500, tau = 2.5 } = {}) {
    this.value = value;
    this.dir = dir;
    this.holdBand = holdBand;
    this.holdMs = holdMs;
    this.tau = tau;
    this.nearAt = 0;
    this.releasing = false;
  }

  /** Jump to `value`, forgetting the hysteresis so far. */
  reset(value) {
    this.value = value;
    this.nearAt = 0;
    this.releasing = false;
  }

  /**
   * Advance one frame.
   * @param {number} required where the data wants the limit
   * @param {{now: number, dt: number, snap?: boolean}} step frame clock:
   *   timestamp in ms, elapsed seconds, and whether to skip the glide
   *   (a setting changed, so gliding from the old range is meaningless)
   * @param {number} [holdBand] override for this frame
   * @returns {number} the new position
   */
  track(required, step, holdBand = this.holdBand) {
    const slack = this.dir * (required - this.value); // > 0: must give way now
    if (step.snap || slack >= 0) {
      this.nearAt = step.now;
      this.releasing = false;
      this.value = required;
    } else if (!this.releasing && slack > -holdBand) {
      this.nearAt = step.now;                          // near enough: hold
    } else if (this.releasing || step.now - this.nearAt >= this.holdMs) {
      this.releasing = true;
      this.value += (1 - Math.exp(-step.dt / this.tau)) * (required - this.value);
      if (Math.abs(required - this.value) < 0.05) {    // arrived
        this.value = required;
        this.nearAt = step.now;
        this.releasing = false;
      }
    }
    return this.value;
  }
}
