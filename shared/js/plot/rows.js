// Display-row -> source-index ranges for heatmap rows.
//
// A spectrogram display has a fixed number of rows; the analysis has its
// own bins (FFT) or scales (CWT). When rows are coarser than bins, sampling
// one bin per row drops narrow tones that fall between the sampled bins.
// Each row therefore covers every source index between the half-way
// points to its neighbouring rows, and takes the maximum over that range.

/**
 * @param {ArrayLike<number>} rowFreqs centre frequency of each row (any order, monotonic)
 * @param {(f:number)=>number} freqToIndex fractional source index for a frequency (monotonic increasing)
 * @param {number} maxIndex highest valid source index
 * @returns {{lo: Int32Array, hi: Int32Array}} inclusive index range per row
 */
export function rowRanges(rowFreqs, freqToIndex, maxIndex) {
  const n = rowFreqs.length;
  const lo = new Int32Array(n);
  const hi = new Int32Array(n);
  const clamp = (i) => Math.max(0, Math.min(maxIndex, i));
  for (let r = 0; r < n; r++) {
    const f = rowFreqs[r];
    const ePrev = r > 0 ? 0.5 * (rowFreqs[r - 1] + f) : f;
    const eNext = r < n - 1 ? 0.5 * (f + rowFreqs[r + 1]) : f;
    const a = Math.min(ePrev, eNext);
    const b = Math.max(ePrev, eNext);
    let i0 = Math.ceil(freqToIndex(a) - 1e-9);
    let i1 = Math.floor(freqToIndex(b) + 1e-9);
    if (i1 < i0) i0 = i1 = Math.round(freqToIndex(f));
    lo[r] = clamp(i0);
    hi[r] = clamp(i1);
  }
  return { lo, hi };
}

/** Maximum of values[lo[r]..hi[r]] inclusive. */
export function rowMax(values, lo, hi, r) {
  let m = values[lo[r]];
  for (let i = lo[r] + 1; i <= hi[r]; i++) if (values[i] > m) m = values[i];
  return m;
}
