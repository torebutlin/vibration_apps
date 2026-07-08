// Web Worker wrapping MorletCWT so scaleogram columns are computed off the
// main thread. Protocol:
//   in : {type:'config', fullSize, sampleRate, fMin, fMax, binsPerOctave, omega0}
//   out: {type:'ready', freqs, latencySeconds, decRate}
//   in : {type:'analyze', samples: Float32Array, nCols, colStride}
//   out: {type:'result', data: Float32Array (nScales x nCols), nCols}

import { MorletCWT } from '../../../../shared/js/dsp/cwt.js';

let cwt = null;

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'config') {
    try {
      cwt = new MorletCWT(msg);
      self.postMessage({
        type: 'ready',
        freqs: Array.from(cwt.freqs),
        latencySeconds: cwt.latencySeconds,
        decRate: cwt.decRate,
        // usable span: keep 4-sigma clear of BOTH block edges (the newest
        // edge for causality, the oldest against wraparound artifacts)
        maxCols: cwt.decSize - 1 - 2 * cwt.latencyDec,
      });
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message });
    }
  } else if (msg.type === 'analyze' && cwt) {
    try {
      const out = cwt.analyze(msg.samples, msg.nCols, msg.colStride);
      self.postMessage({ type: 'result', data: out, nCols: msg.nCols }, [out.buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message });
    }
  }
};
