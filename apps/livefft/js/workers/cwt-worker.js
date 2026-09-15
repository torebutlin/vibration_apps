// Web Worker wrapping StreamingCWT so scaleogram columns are computed off
// the main thread. Protocol:
//   in : {type:'config', sampleRate, fMin, fMax, binsPerOctave, omega0,
//         bandwidth, hopSamples}
//   out: {type:'ready', freqs, lagCols, lagSeconds, minLagSeconds,
//         maxLagSeconds, hop, decimation}
//   in : {type:'push', samples: Float32Array, startTotal, sentAt}
//        samples are the new full-rate samples since the previous push;
//        startTotal is the engine sample count at the first of them
//   out: {type:'columns', data: Float32Array (nScales x nCols), nCols,
//         headCol, colTotal0, skip}
//
// Each scale lags the head by its own whole number of columns, so value
// data[j * nCols + k] belongs to column headCol - (nCols - 1) + k -
// lagCols[j], and colTotal0 + col * hop is that column's engine sample
// count. The main thread therefore knows each row's own newest instant,
// and can draw the treble as soon as it exists instead of holding it back
// for the bass.
//
// A slow device degrades gracefully: when a column costs more than a
// fraction of its own period (or pushes queue up), the worker computes
// every k-th head and repeats it for the others, so the display keeps its
// cadence at a coarser time resolution instead of stalling.

import { StreamingCWT } from '../../../../shared/js/dsp/cwt.js';

let cwt = null;
let origin = null;
let lastHead = null;
let last = null;
let skip = 1;
let costEma = 0;

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'config') {
    try {
      cwt = new StreamingCWT(msg);
      origin = null;
      lastHead = null;
      last = new Float32Array(cwt.nScales);
      skip = 1;
      costEma = 0;
      self.postMessage({
        type: 'ready',
        freqs: Array.from(cwt.freqs),
        lagCols: Array.from(cwt.lagCols),
        lagSeconds: Array.from(cwt.lagSeconds),
        minLagSeconds: cwt.minLagSeconds,
        maxLagSeconds: cwt.maxLagSeconds,
        hop: cwt.hop,
        decimation: cwt.decimation,
        ringSeconds: cwt.ringSeconds,
      });
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message });
    }
    return;
  }
  if (msg.type !== 'push' || !cwt) return;
  if (origin === null) origin = msg.startTotal;
  cwt.push(msg.samples);

  const budgetMs = (cwt.hop / cwt.sampleRate) * 1000;
  // pushes that sat in the queue mean we are behind: coarsen right away
  const age = Date.now() - (msg.sentAt || Date.now());
  if (age > 400) skip = Math.min(8, skip * 2);

  const cols = [];
  let k = 0;
  let head = null;
  while (cwt.pending > 0) {
    let h;
    if (k % skip === 0) {
      const t0 = performance.now();
      const out = new Float32Array(cwt.nScales);
      h = cwt.nextColumn(out);
      costEma = 0.85 * costEma + 0.15 * (performance.now() - t0);
      last = out;
    } else {
      h = cwt.skipColumn();
    }
    // the ring overflowed and the stream jumped: repeat the previous
    // values for the heads that were dropped so the time axis stays true
    if (lastHead !== null) {
      for (let g = 0; g < Math.min(h - lastHead - 1, 1024); g++) cols.push(last);
    }
    cols.push(last);
    lastHead = h;
    head = h;
    k++;
  }
  if (cols.length === 0) return;

  // adapt the skip to the measured cost per column
  if (costEma > 0.5 * budgetMs) skip = Math.min(8, Math.ceil(costEma / (0.5 * budgetMs)));
  else if (costEma < 0.15 * budgetMs && skip > 1) skip -= 1;

  const nCols = cols.length;
  const data = new Float32Array(cwt.nScales * nCols);
  for (let c = 0; c < nCols; c++) {
    const col = cols[c];
    for (let j = 0; j < cwt.nScales; j++) data[j * nCols + c] = col[j];
  }
  self.postMessage(
    {
      type: 'columns',
      data,
      nCols,
      headCol: head,
      colTotal0: origin - cwt.groupDelay,
      skip,
    },
    [data.buffer]
  );
};
