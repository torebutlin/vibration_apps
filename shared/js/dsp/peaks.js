// Peak finding for spectrum labelling.

/**
 * Find the most significant peaks of a spectrum for labelling.
 *
 * Works on a dB-domain array. A bin is a candidate if it is a local
 * maximum above `floorDb` relative to the global maximum. Candidates are
 * accepted greedily from highest down, subject to:
 *   - at least `minSeparationBins` from every accepted peak, and
 *   - the deepest valley between it and the nearest accepted peak sits at
 *     least `minProminenceDb` below the candidate (rejects shoulder points
 *     on the skirt of a larger peak).
 *
 * @param {Float32Array|Float64Array} db spectrum in dB
 * @param {number} maxPeaks
 * @param {object} [opts]
 * @returns {{bin: number, db: number, frac: number}[]} peaks, frac is the
 *   parabolic-interpolation bin offset in (-0.5, 0.5) for sub-bin frequency
 */
export function findPeaks(db, maxPeaks = 5, opts = {}) {
  const {
    floorDb = 60,          // ignore anything more than this below the max
    minSeparationBins = 4,
    minProminenceDb = 6,
    startBin = 1,          // skip DC by default
  } = opts;

  const n = db.length;
  let globalMax = -Infinity;
  for (let i = startBin; i < n; i++) if (db[i] > globalMax) globalMax = db[i];
  if (!isFinite(globalMax)) return [];
  const threshold = globalMax - floorDb;

  const candidates = [];
  for (let i = Math.max(1, startBin); i < n - 1; i++) {
    if (db[i] >= threshold && db[i] > db[i - 1] && db[i] >= db[i + 1]) {
      candidates.push(i);
    }
  }
  candidates.sort((a, b) => db[b] - db[a]);

  const accepted = [];
  for (const c of candidates) {
    if (accepted.length >= maxPeaks) break;
    let ok = true;
    for (const a of accepted) {
      if (Math.abs(a - c) < minSeparationBins) { ok = false; break; }
      // valley test between c and its nearest accepted neighbour
      const lo = Math.min(a, c), hi = Math.max(a, c);
      let valley = Infinity;
      for (let i = lo; i <= hi; i++) if (db[i] < valley) valley = db[i];
      if (db[c] - valley < minProminenceDb) { ok = false; break; }
    }
    if (ok) accepted.push(c);
  }

  accepted.sort((a, b) => a - b);
  return accepted.map((bin) => {
    // Parabolic interpolation on the dB values for sub-bin accuracy
    let frac = 0;
    if (bin > 0 && bin < n - 1) {
      const y0 = db[bin - 1], y1 = db[bin], y2 = db[bin + 1];
      const denom = y0 - 2 * y1 + y2;
      if (denom < -1e-12) frac = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom));
    }
    return { bin, db: db[bin], frac };
  });
}
