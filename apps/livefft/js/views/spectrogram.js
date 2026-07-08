// Spectrogram view: scrolling time-frequency heatmap.
//
// Two engines:
//   STFT — windowed FFT columns on a fixed column clock (span/COLS seconds
//          per column), sampled onto display rows per the freq axis.
//   CWT  — Morlet scaleogram columns from a Web Worker (multi-resolution;
//          display trails real time by the wavelet latency).
//
// A raw dB ring (COLS x ROWS) is kept alongside the pixel ring so colormap
// or range changes repaint the whole history, not just new columns.

import { rfftMagSq } from '../../../../shared/js/dsp/fft.js';
import { getWindow } from '../../../../shared/js/dsp/windows.js';
import { getColormap } from '../../../../shared/js/plot/colormap.js';
import { Axes, fmtHz } from '../../../../shared/js/plot/axes.js';

const COLS = 1024;
const ROWS = 512;

export class SpectrogramView {
  constructor(state) {
    this.state = state;
    this.axes = new Axes();
    this.sampleRate = 48000;

    this.img = document.createElement('canvas');
    this.img.width = COLS;
    this.img.height = ROWS;
    this.imgCtx = this.img.getContext('2d', { willReadFrequently: false });
    this.colImage = this.imgCtx.createImageData(1, ROWS);
    this.rawRing = new Float32Array(COLS * ROWS).fill(-160);
    this.writeCol = 0;

    this.worker = null;
    this.workerReady = false;
    this.workerBusy = false;
    this.cwtFreqs = null;
    this.cwtLatency = 0;
    this.cwtDecRate = 0;
    this.lastDecSent = 0;

    this.sinceCol = 0;      // samples since last emitted column (stft)
    this.lastTotal = 0;
    this.scratch = new Float32Array(1);
    this.windowed = null;
    this.power = null;
    this.dbCol = new Float32Array(ROWS);
    this.rowMap = null;     // row -> source bin/scale index

    this.#rebuild();
    state.on(
      ['sgMode', 'sgSpan', 'fftSize', 'windowName', 'freqScale', 'freqMin', 'freqMax', 'freqAuto',
        'cwtFMin', 'cwtFMax', 'cwtBinsPerOctave', 'cwtOmega0'],
      () => this.#rebuild()
    );
    state.on(['sgColormap', 'sgFloorDb', 'sgCeilDb'], () => this.#repaintAll());
  }

  setSampleRate(fs) {
    if (fs !== this.sampleRate) {
      this.sampleRate = fs;
      this.#rebuild();
    }
  }

  get isCwt() {
    return this.state.get('sgMode') === 'cwt';
  }

  /** Display frequency range: manual/auto for STFT, scale range for CWT. */
  #freqRange() {
    const s = this.state;
    if (this.isCwt) {
      return { min: s.get('cwtFMin'), max: Math.min(s.get('cwtFMax'), this.sampleRate / 2), log: true };
    }
    const log = s.get('freqScale') === 'log';
    if (s.get('freqAuto')) return { min: log ? 20 : 0, max: this.sampleRate / 2, log };
    return {
      min: log ? Math.max(s.get('freqMin'), 1) : s.get('freqMin'),
      max: Math.min(s.get('freqMax'), this.sampleRate / 2),
      log,
    };
  }

  #rebuild() {
    const s = this.state;
    const fs = this.sampleRate;
    this.colPeriodSamples = (s.get('sgSpan') * fs) / COLS;
    this.sinceCol = 0;
    this.lastTotal = 0;
    this.rawRing.fill(-160);
    this.imgCtx.fillStyle = '#000';
    this.imgCtx.fillRect(0, 0, COLS, ROWS);
    this.writeCol = 0;

    const fr = this.#freqRange();
    this.rowMap = new Float32Array(ROWS);

    if (!this.isCwt) {
      const n = s.get('fftSize');
      this.fftSize = n;
      const { w, coherentGain } = getWindow(s.get('windowName'), n);
      this.win = w;
      this.ampScale = 2 / (n * coherentGain);
      this.windowed = new Float64Array(n);
      this.power = new Float64Array(n / 2 + 1);
      if (this.scratch.length < n) this.scratch = new Float32Array(n);
      const binHz = fs / n;
      for (let r = 0; r < ROWS; r++) {
        const t = 1 - r / (ROWS - 1); // row 0 = top = fmax
        const f = fr.log ? fr.min * Math.pow(fr.max / fr.min, 1 - r / (ROWS - 1)) : fr.min + t * (fr.max - fr.min);
        this.rowMap[r] = Math.min(Math.round(f / binHz), n / 2);
      }
      if (this.worker) {
        this.worker.terminate();
        this.worker = null;
        this.workerReady = false;
        this.workerBusy = false;
      }
    } else {
      this.#setupWorker(fr);
    }
    this.#applyColormap();
  }

  #setupWorker(fr) {
    if (this.worker) this.worker.terminate();
    this.workerReady = false;
    this.workerBusy = false;
    this.worker = new Worker(new URL('../workers/cwt-worker.js', import.meta.url), { type: 'module' });
    const s = this.state;
    // block long enough for the 4-sigma latency of the lowest wavelet PLUS
    // ~1 s of usable output columns per analysis call
    const omega0 = s.get('cwtOmega0');
    const sigmaMax = omega0 / (2 * Math.PI * fr.min);
    let fullSize = 16384;
    while (fullSize / this.sampleRate < 8 * sigmaMax + 1.0 && fullSize < 1 << 20) fullSize <<= 1;
    this.cwtFullSize = fullSize;
    this.worker.postMessage({
      type: 'config',
      fullSize,
      sampleRate: this.sampleRate,
      fMin: fr.min,
      fMax: fr.max,
      binsPerOctave: s.get('cwtBinsPerOctave'),
      omega0,
    });
    this.worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'error') {
        this.workerBusy = false;
        console.error('CWT worker:', msg.message);
      } else if (msg.type === 'ready') {
        this.workerReady = true;
        this.cwtFreqs = msg.freqs;
        this.cwtLatency = msg.latencySeconds;
        this.cwtDecRate = msg.decRate;
        this.cwtMaxCols = msg.maxCols; // decimated samples usable per call
        this.lastDecSent = 0;
        // row -> scale index (freqs are log-spaced, display log too)
        const nS = msg.freqs.length;
        const logMin = Math.log(msg.freqs[0]);
        const logMax = Math.log(msg.freqs[nS - 1]);
        for (let r = 0; r < ROWS; r++) {
          const lf = logMax - (r / (ROWS - 1)) * (logMax - logMin);
          this.rowMap[r] = Math.min(nS - 1, Math.max(0, Math.round(((lf - logMin) / (logMax - logMin)) * (nS - 1))));
        }
      } else if (msg.type === 'result') {
        this.workerBusy = false;
        this.#writeCwtColumns(msg.data, msg.nCols);
      }
    };
  }

  #applyColormap() {
    this.lut = getColormap(this.state.get('sgColormap'));
  }

  #dbToColor(db) {
    const s = this.state;
    const floor = s.get('sgFloorDb');
    const ceil = s.get('sgCeilDb');
    let t = (db - floor) / (ceil - floor);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.round(t * 255);
  }

  #writeColumn(dbValues) {
    // dbValues: Float32Array(ROWS), top row first
    const px = this.colImage.data;
    const lut = this.lut;
    const base = this.writeCol * ROWS;
    for (let r = 0; r < ROWS; r++) {
      const db = dbValues[r];
      this.rawRing[base + r] = db;
      const ci = this.#dbToColor(db) * 3;
      const o = r * 4;
      px[o] = lut[ci];
      px[o + 1] = lut[ci + 1];
      px[o + 2] = lut[ci + 2];
      px[o + 3] = 255;
    }
    this.imgCtx.putImageData(this.colImage, this.writeCol, 0);
    this.writeCol = (this.writeCol + 1) % COLS;
  }

  #repaintAll() {
    this.#applyColormap();
    const px = this.colImage.data;
    const lut = this.lut;
    for (let c = 0; c < COLS; c++) {
      const base = c * ROWS;
      for (let r = 0; r < ROWS; r++) {
        const ci = this.#dbToColor(this.rawRing[base + r]) * 3;
        const o = r * 4;
        px[o] = lut[ci];
        px[o + 1] = lut[ci + 1];
        px[o + 2] = lut[ci + 2];
        px[o + 3] = 255;
      }
      this.imgCtx.putImageData(this.colImage, c, 0);
    }
  }

  #writeCwtColumns(data, nCols) {
    // data: Float32Array nScales x nCols (row-major by scale), amplitudes
    const nS = this.cwtFreqs.length;
    for (let c = 0; c < nCols; c++) {
      for (let r = 0; r < ROWS; r++) {
        const j = this.rowMap[r];
        const amp = data[j * nCols + c];
        this.dbCol[r] = 20 * Math.log10(Math.max(amp, 1e-12));
      }
      this.#writeColumn(this.dbCol);
    }
  }

  tick(engine, _dt) {
    const total = engine.totalSamples;
    if (this.lastTotal === 0) {
      this.lastTotal = total;
      return;
    }
    const fresh = total - this.lastTotal;
    this.lastTotal = total;
    if (fresh <= 0) return;

    if (!this.isCwt) {
      this.sinceCol += fresh;
      let toEmit = Math.floor(this.sinceCol / this.colPeriodSamples);
      if (toEmit <= 0) return;
      this.sinceCol -= toEmit * this.colPeriodSamples;
      // catch-up bound: after a stall the current spectrum is duplicated
      // rather than dropping display time entirely
      toEmit = Math.min(toEmit, 64);
      const n = this.fftSize;
      const view = this.scratch.subarray(0, n);
      if (!engine.read(n, view)) return;
      // one spectrum reused for all due columns this frame (columns are
      // closer together than one FFT window anyway)
      for (let i = 0; i < n; i++) this.windowed[i] = view[i] * this.win[i];
      rfftMagSq(this.windowed, this.power);
      const nBins = n / 2 + 1;
      for (let r = 0; r < ROWS; r++) {
        const b = this.rowMap[r];
        const edge = b === 0 || b === nBins - 1;
        let amp = this.ampScale * Math.sqrt(Math.max(this.power[b], 0));
        if (edge) amp /= 2;
        this.dbCol[r] = 20 * Math.log10(Math.max(amp, 1e-12));
      }
      for (let e = 0; e < toEmit; e++) this.#writeColumn(this.dbCol);
    } else if (this.workerReady && !this.workerBusy) {
      const decPerCol = Math.max(1, Math.round((this.colPeriodSamples * this.cwtDecRate) / this.sampleRate));
      const nowDec = Math.floor((total * this.cwtDecRate) / this.sampleRate);
      if (this.lastDecSent === 0) this.lastDecSent = nowDec;
      const elapsed = nowDec - this.lastDecSent;
      const maxCols = Math.max(1, Math.floor(this.cwtMaxCols / decPerCol));
      const nCols = Math.min(Math.floor(elapsed / decPerCol), maxCols, 256);
      if (nCols < 1) return;
      if (engine.totalSamples < this.cwtFullSize) return;
      const buf = new Float32Array(this.cwtFullSize);
      if (!engine.read(this.cwtFullSize, buf)) return;
      // advance by the full backlog: anything beyond nCols is dropped
      // (display resumes at real time after a stall)
      this.lastDecSent = nowDec - (elapsed % decPerCol);
      this.workerBusy = true;
      this.worker.postMessage(
        { type: 'analyze', samples: buf, nCols, colStride: decPerCol },
        [buf.buffer]
      );
    }
  }

  render(ctx, w, h, hover) {
    const s = this.state;
    const fr = this.#freqRange();
    const m = { l: 64, r: 14, t: 14, b: 46 };
    this.axes.setRect(m.l, m.t, w - m.l - m.r, h - m.t - m.b);
    const span = s.get('sgSpan');
    this.axes.setX(-span, 0, false);
    this.axes.setY(fr.min, fr.max, fr.log);

    ctx.clearRect(0, 0, w, h);
    const r = this.axes.rect;

    // heatmap: ring buffer as two slices; newest column at right edge
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    const wNew = this.writeCol;            // columns 0..writeCol-1 are newest chunk's tail
    const wOld = COLS - wNew;
    if (wOld > 0) {
      ctx.drawImage(this.img, wNew, 0, wOld, ROWS, r.x, r.y, (wOld / COLS) * r.w, r.h);
    }
    if (wNew > 0) {
      ctx.drawImage(this.img, 0, 0, wNew, ROWS, r.x + (wOld / COLS) * r.w, r.y, (wNew / COLS) * r.w, r.h);
    }
    ctx.restore();

    // frame + labels, no grid over the image
    this.axes.draw(ctx, {
      xLabel: 'time · s',
      yLabel: 'frequency · Hz',
      xFmt: (v) => (Math.abs(v % 1) < 1e-6 ? v.toFixed(0) : v.toFixed(1)),
      yFmt: fmtHz,
      theme: { grid: 'transparent', gridStrong: 'transparent' },
    });

    // colorbar hint + latency note
    ctx.font = '500 10px "JetBrains Mono", monospace';
    ctx.fillStyle = '#56617a';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    const range = `${s.get('sgFloorDb')}…${s.get('sgCeilDb')} dBFS`;
    const note = this.isCwt && this.cwtLatency
      ? `CWT · display −${this.cwtLatency.toFixed(2)} s · ${range}`
      : range;
    ctx.fillText(note, r.x + r.w - 4, r.y + 4);

    if (hover && this.axes.inRect(hover.x, hover.y)) {
      const freq = this.axes.pxToY(hover.y);
      const time = this.axes.pxToX(hover.x);
      const freqTxt = freq >= 1000 ? `${(freq / 1000).toFixed(2)} kHz` : `${freq.toFixed(0)} Hz`;
      const text = `${time.toFixed(2)} s  ${freqTxt}`;
      ctx.font = '500 11px "JetBrains Mono", monospace';
      const tw = ctx.measureText(text).width + 14;
      const bx = Math.min(hover.x + 12, r.x + r.w - tw - 4);
      const by = Math.max(hover.y - 30, r.y + 4);
      ctx.fillStyle = 'rgba(13, 17, 25, 0.85)';
      ctx.fillRect(bx, by, tw, 20);
      ctx.strokeStyle = 'rgba(158, 178, 216, 0.3)';
      ctx.strokeRect(bx + 0.5, by + 0.5, tw - 1, 19);
      ctx.fillStyle = '#d9e2f4';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, bx + 7, by + 10);
    }
  }
}
