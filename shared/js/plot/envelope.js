// Min/max envelope of a sample run for drawing at pixel resolution. Taking
// every k-th sample aliases (a 440 Hz tone drawn at 120 samples/px looks
// like a 40 Hz wave); min/max per column keeps the true excursion.

/**
 * @param {Float32Array} buf samples
 * @param {number} start first sample index
 * @param {number} n number of samples to cover
 * @param {number} cols number of output columns (pixels)
 * @param {Float32Array} outMin length >= cols
 * @param {Float32Array} outMax length >= cols
 */
export function minMaxEnvelope(buf, start, n, cols, outMin, outMax) {
  for (let c = 0; c < cols; c++) {
    const i0 = start + Math.floor((c * n) / cols);
    let i1 = start + Math.floor(((c + 1) * n) / cols);
    if (i1 <= i0) i1 = i0 + 1;
    let mn = buf[i0];
    let mx = buf[i0];
    for (let i = i0 + 1; i < i1; i++) {
      const v = buf[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    outMin[c] = mn;
    outMax[c] = mx;
  }
}
