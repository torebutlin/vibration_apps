// Moving average of the last N power spectra: a boxcar window that slides
// with every frame, as opposed to the exponential average's infinite tail.
//
// Frames arrive faster than they are independent — the display hops by less
// than half a window — so each one carries a weight, and the window holds a
// fixed number of *independent* frames however often they come.
//
// The window is a ring of slots. One slot per independent frame is the
// ideal, but a long FFT with many averages would then cost tens of
// megabytes, so a slot may bank several frames instead: the window is still
// exactly N frames long, it just slides in coarser steps. To keep the mean
// over exactly N frames between those steps, the oldest slot is taken out
// in proportion to how far the newest one has filled — the window's trailing
// edge moves continuously while its leading edge does.

/** Ceiling on one window's storage. A slot holds nBins floats. */
const BUDGET_BYTES = 4 << 20;

export class RollingPowerAverage {
  /**
   * @param {number} nBins bins per spectrum
   * @param {number} target independent frames the window spans
   * @param {number} budgetBytes ceiling on the ring's storage
   */
  constructor(nBins, target, budgetBytes = BUDGET_BYTES) {
    this.nBins = nBins;
    this.target = Math.max(target, 1e-9);
    const affordable = Math.max(1, Math.floor(budgetBytes / (nBins * 4)));
    this.slotCount = Math.max(1, Math.min(Math.ceil(this.target), affordable));
    // an exact division: the slots always span the target between them,
    // whatever the budget allowed
    this.slotWeight = this.target / this.slotCount;
    // one slot more than the window holds: the one being filled
    this.slots = new Float32Array((this.slotCount + 1) * nBins);
    this.sum = new Float64Array(nBins);   // the complete slots, summed
    this.reset();
  }

  reset() {
    this.slots.fill(0);
    this.sum.fill(0);
    this.tail = 0;    // oldest complete slot
    this.head = 0;    // slot being filled
    this.filled = 0;  // complete slots in the ring
    this.fill = 0;    // weight banked in the head slot
    this.closes = 0;
  }

  /** Independent frames the window currently holds, up to the target. */
  get frames() {
    return Math.min(this.filled * this.slotWeight + this.fill, this.target);
  }

  /** True once the window spans its full target. */
  get full() {
    return this.filled >= this.slotCount;
  }

  /**
   * Fold one frame in.
   * @param {Float64Array} power one-sided |X|^2
   * @param {number} weight what it is worth as an independent frame
   */
  add(power, weight) {
    let left = weight;
    while (left > 1e-12) {
      const take = Math.min(this.slotWeight - this.fill, left);
      const at = this.head * this.nBins;
      const s = this.slots;
      for (let k = 0; k < this.nBins; k++) s[at + k] += power[k] * take;
      this.fill += take;
      left -= take;
      if (this.fill >= this.slotWeight - 1e-9) this.#close();
    }
  }

  /** Bank the head slot, dropping the oldest if the window is full. */
  #close() {
    const n = this.nBins;
    const s = this.slots;
    const ring = this.slotCount + 1;
    if (this.filled >= this.slotCount) {
      const at = this.tail * n;
      for (let k = 0; k < n; k++) this.sum[k] -= s[at + k];
      this.tail = (this.tail + 1) % ring;
      this.filled--;
    }
    const at = this.head * n;
    for (let k = 0; k < n; k++) this.sum[k] += s[at + k];
    this.filled++;
    this.head = (this.head + 1) % ring;
    const next = this.head * n;
    s.fill(0, next, next + n);
    this.fill = 0;
    // a running sum that is added to and subtracted from for hours drifts;
    // rebuilding it once per turn of the ring costs one slot per frame
    if (++this.closes % this.slotCount === 0) this.#rebuild();
  }

  #rebuild() {
    const n = this.nBins;
    const ring = this.slotCount + 1;
    this.sum.fill(0);
    for (let i = 0; i < this.filled; i++) {
      const at = ((this.tail + i) % ring) * n;
      for (let k = 0; k < n; k++) this.sum[k] += this.slots[at + k];
    }
  }

  /**
   * Current mean power over the window.
   * @param {Float64Array} out length nBins
   */
  writeTo(out) {
    const n = this.nBins;
    const s = this.slots;
    const head = this.head * n;
    if (this.filled >= this.slotCount) {
      // full: slide the oldest slot out as the newest fills, so the mean is
      // over exactly `target` frames at every instant
      const f = this.fill / this.slotWeight;
      const tail = this.tail * n;
      const inv = 1 / this.target;
      for (let k = 0; k < n; k++) out[k] = (this.sum[k] + s[head + k] - f * s[tail + k]) * inv;
      return;
    }
    const total = this.filled * this.slotWeight + this.fill;
    if (total <= 0) {
      out.fill(0);
      return;
    }
    const inv = 1 / total;
    for (let k = 0; k < n; k++) out[k] = (this.sum[k] + s[head + k]) * inv;
  }
}
