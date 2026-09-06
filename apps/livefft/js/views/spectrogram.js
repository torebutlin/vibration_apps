// Spectrogram view: scrolling time-frequency heatmap.
//
// Two engines:
//   STFT — windowed FFT columns on a fixed column clock (span/COLS seconds
//          per column), sampled onto display rows per the freq axis.
//   CWT  — streaming Morlet scaleogram from a Web Worker: the view pushes
//          the new samples every frame, the worker returns one column per
//          hop on the audio clock. The display trails real time by the
//          wavelet latency plus a small fixed margin; a slow device gets
//          coarser time steps (repeated columns), never a stall.
//
// A raw dB ring (COLS x ROWS) is kept alongside the pixel ring so colormap
// or range changes repaint the whole history, not just new columns.

import { rfftMagSq } from '../../../../shared/js/dsp/fft.js';
import { getWindow } from '../../../../shared/js/dsp/windows.js';
import { getColormap } from '../../../../shared/js/plot/colormap.js';
import { Axes, fmtHz, plotTheme, plotLayout } from '../../../../shared/js/plot/axes.js';
import { rowRanges, rowMax } from '../../../../shared/js/plot/rows.js';
import { effectiveFreqScale } from '../state.js';

const COLS = 1024;
const ROWS = 512;

// CWT display margin behind the wavelet latency (seconds), so a column is
// always computed before its instant reaches the right edge.
const CWT_MARGIN = 0.12;
// Audio already captured that a fresh worker is fed first, so the display
// fills from the left instead of starting empty.
const CWT_PREHISTORY = 1.0;

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
    this.cwtFreqs = null;
    this.cwtLatencySec = 0;
    this.lastPushed = null;   // engine sample count up to which audio has been sent
    this.cwtSkip = 1;         // worker's current time-step coarsening

    this.sinceCol = 0;      // samples since last emitted column (stft)
    this.lastTotal = 0;
    this.scratch = new Float32Array(1);
    this.windowed = null;
    this.power = null;
    this.dbCol = new Float32Array(ROWS);
    this.rowLo = null;      // per row: inclusive source bin/scale range
    this.rowHi = null;

    this.#rebuild();
    state.on(
      ['sgMode', 'sgSpan', 'fftSize', 'windowName', 'cwtFMin', 'cwtFMax', 'cwtBinsPerOctave', 'cwtOmega0'],
      () => this.#rebuild()
    );
    // axis changes don't need a worker restart in CWT mode — just remap rows
    state.on(['freqScale', 'freqMin', 'freqMax', 'freqAuto'], () => {
      if (this.isCwt && this.workerReady) {
        this.#clearHistory();
        this.#buildCwtRowMap();
      } else {
        this.#rebuild();
      }
    });
    state.on(['sgColormap', 'sgFloorDb', 'sgCeilDb'], () => this.#repaintAll());
    // the raw dB ring survives a theme switch — repaint it in the new palette
    window.addEventListener('themechange', () => this.#repaintAll());
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

  /** Display frequency range: manual/auto for STFT, scale range for CWT
   *  (which respects the lin/log toggle for display). */
  #freqRange() {
    const s = this.state;
    const log = effectiveFreqScale(s, 'spectrogram') === 'log';
    if (this.isCwt) {
      return { min: s.get('cwtFMin'), max: Math.min(s.get('cwtFMax'), this.sampleRate / 2), log };
    }
    if (s.get('freqAuto')) return { min: log ? 20 : 0, max: this.sampleRate / 2, log };
    return {
      min: log ? Math.max(s.get('freqMin'), 1) : s.get('freqMin'),
      max: Math.min(s.get('freqMax'), this.sampleRate / 2),
      log,
    };
  }

  /** Frequency at display row r for the current range (row 0 = top = fmax). */
  #rowFreq(r, fr) {
    const t = 1 - r / (ROWS - 1);
    return fr.log ? fr.min * Math.pow(fr.max / fr.min, t) : fr.min + t * (fr.max - fr.min);
  }

  /** Row centre frequencies, top row first. */
  #rowFreqs(fr) {
    const out = new Float64Array(ROWS);
    for (let r = 0; r < ROWS; r++) out[r] = this.#rowFreq(r, fr);
    return out;
  }

  #clearHistory() {
    this.rawRing.fill(-160);
    this.#applyColormap();
    const lut = this.lut;
    this.imgCtx.fillStyle = `rgb(${lut[0]}, ${lut[1]}, ${lut[2]})`;
    this.imgCtx.fillRect(0, 0, COLS, ROWS);
    this.writeCol = 0;
  }

  #buildCwtRowMap() {
    const fr = this.#freqRange();
    const freqs = this.cwtFreqs;
    const nS = freqs.length;
    const logMin = Math.log(freqs[0]);
    const logSpan = Math.log(freqs[nS - 1]) - logMin;
    const rowFreqs = this.#rowFreqs(fr);
    for (let r = 0; r < ROWS; r++) rowFreqs[r] = Math.min(Math.max(rowFreqs[r], freqs[0]), freqs[nS - 1]);
    const { lo, hi } = rowRanges(rowFreqs, (f) => ((Math.log(f) - logMin) / logSpan) * (nS - 1), nS - 1);
    this.rowLo = lo;
    this.rowHi = hi;
  }

  #rebuild() {
    const s = this.state;
    const fs = this.sampleRate;
    // CWT: the ring must cover span + latency + margin. The latency here is
    // an estimate for sizing; the worker reports the exact latency and the
    // exact column period once configured.
    const latencyGuess = (4 * s.get('cwtOmega0')) / (2 * Math.PI * s.get('cwtFMin'));
    this.displayDelaySec = this.isCwt ? latencyGuess + CWT_MARGIN : 0;
    this.colPeriodSamples =
      ((s.get('sgSpan') + (this.isCwt ? latencyGuess + CWT_MARGIN + 0.5 : 0)) * fs) / COLS;
    this.sinceCol = 0;
    this.lastTotal = 0;
    this.newestColTotal = 0;
    this.curTotal = 0;
    this.#clearHistory();

    const fr = this.#freqRange();

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
      const { lo, hi } = rowRanges(this.#rowFreqs(fr), (f) => f / binHz, n / 2);
      this.rowLo = lo;
      this.rowHi = hi;
      if (this.worker) {
        this.worker.terminate();
        this.worker = null;
        this.workerReady = false;
      }
    } else {
      this.#setupWorker(fr);
    }
    this.#applyColormap();
  }

  #setupWorker(fr) {
    if (this.worker) this.worker.terminate();
    this.workerReady = false;
    this.lastPushed = null;
    this.cwtSkip = 1;
    this.worker = new Worker(new URL('../workers/cwt-worker.js', import.meta.url), { type: 'module' });
    const s = this.state;
    this.worker.postMessage({
      type: 'config',
      sampleRate: this.sampleRate,
      fMin: fr.min,
      fMax: fr.max,
      binsPerOctave: s.get('cwtBinsPerOctave'),
      omega0: s.get('cwtOmega0'),
      hopSamples: Math.round(this.colPeriodSamples),
    });
    this.worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'error') {
        console.error('CWT worker:', msg.message);
      } else if (msg.type === 'ready') {
        this.workerReady = true;
        this.cwtFreqs = msg.freqs;
        this.cwtLatencySec = msg.latencySeconds;
        this.colPeriodSamples = msg.hop; // the worker's exact column period
        this.displayDelaySec = msg.latencySeconds + CWT_MARGIN;
        this.#buildCwtRowMap();
      } else if (msg.type === 'columns') {
        this.cwtSkip = msg.skip;
        this.#writeCwtColumns(msg.data, msg.nCols);
        this.newestColTotal = msg.endTotal;
      }
    };
  }

  #applyColormap() {
    // light theme gets the reversed variant: silence is the page ground
    const lightBg = document.documentElement.dataset.theme === 'light';
    const m = /^#([0-9a-f]{6})$/i.exec(plotTheme().bg);
    const ground = m
      ? [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)]
      : [255, 255, 255];
    this.lut = getColormap(this.state.get('sgColormap'), lightBg, ground);
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
    for (let c = 0; c < nCols; c++) {
      for (let r = 0; r < ROWS; r++) {
        let amp = 0;
        for (let j = this.rowLo[r]; j <= this.rowHi[r]; j++) {
          const a = data[j * nCols + c];
          if (a > amp) amp = a;
        }
        this.dbCol[r] = 20 * Math.log10(Math.max(amp, 1e-12));
      }
      this.#writeColumn(this.dbCol);
    }
  }

  tick(engine, _dt) {
    const total = engine.totalSamples;
    this.curTotal = total; // render uses this for smooth time-based scrolling
    if (this.lastTotal === 0) {
      this.lastTotal = total;
      this.newestColTotal = total;
      return;
    }
    const fresh = total - this.lastTotal;
    this.lastTotal = total;
    if (fresh <= 0) return;

    if (!this.isCwt) {
      this.sinceCol += fresh;
      let toEmit = Math.floor(this.sinceCol / this.colPeriodSamples);
      if (toEmit <= 0) return;
      // After a stall the current spectrum is duplicated into every due
      // column (up to a full ring) so the time axis stays true; a backlog
      // longer than the ring is dropped and the display resumes at real time.
      if (toEmit > COLS) {
        this.sinceCol -= (toEmit - COLS) * this.colPeriodSamples;
        toEmit = COLS;
      }
      this.sinceCol -= toEmit * this.colPeriodSamples;
      this.newestColTotal = total - this.sinceCol;
      const n = this.fftSize;
      const view = this.scratch.subarray(0, n);
      if (!engine.read(n, view)) return;
      // one spectrum reused for all due columns this frame (columns are
      // closer together than one FFT window anyway)
      for (let i = 0; i < n; i++) this.windowed[i] = view[i] * this.win[i];
      rfftMagSq(this.windowed, this.power);
      const nBins = n / 2 + 1;
      for (let r = 0; r < ROWS; r++) {
        const p = rowMax(this.power, this.rowLo, this.rowHi, r);
        const edge = this.rowLo[r] === 0 || this.rowHi[r] === nBins - 1;
        let amp = this.ampScale * Math.sqrt(Math.max(p, 0));
        if (edge && this.rowLo[r] === this.rowHi[r]) amp /= 2;
        this.dbCol[r] = 20 * Math.log10(Math.max(amp, 1e-12));
      }
      for (let e = 0; e < toEmit; e++) this.#writeColumn(this.dbCol);
    } else if (this.workerReady) {
      // stream every new sample to the worker; it answers with columns
      if (this.lastPushed === null) {
        this.lastPushed = Math.max(0, total - Math.round(CWT_PREHISTORY * this.sampleRate));
      }
      const pending = total - this.lastPushed;
      if (pending <= 0) return;
      if (pending > 6 * this.sampleRate) {
        // a long stall (tab in the background): restart the stream rather
        // than push a gap the worker cannot know about
        this.#setupWorker(this.#freqRange());
        return;
      }
      const buf = new Float32Array(pending);
      if (!engine.read(pending, buf)) return;
      this.worker.postMessage(
        { type: 'push', samples: buf, startTotal: this.lastPushed, sentAt: Date.now() },
        [buf.buffer]
      );
      this.lastPushed = total;
    }
  }

  render(ctx, w, h, hover, _rubber, layout = {}) {
    const s = this.state;
    const fr = this.#freqRange();
    const L = plotLayout(w, h, layout);
    this.axes.setRect(L.rect.x, L.rect.y, L.rect.w, L.rect.h);
    const span = s.get('sgSpan');
    this.axes.setX(-span, 0, false);
    this.axes.setY(fr.min, fr.max, fr.log);

    ctx.clearRect(0, 0, w, h);
    const r = this.axes.rect;

    // Smooth scrolling on the audio clock. The plot maps display time
    // [now - D - span, now - D] where D is the display delay (0 for STFT).
    // The ring holds span + D seconds, so freshly computed CWT columns
    // overhang the right edge and glide into view — no hovering gap, and
    // the left edge stays covered too.
    const fsr = this.sampleRate;
    const dSamples = this.displayDelaySec * fsr;
    const pxPerSample = r.w / (s.get('sgSpan') * fsr);
    let xEnd = r.x + r.w; // newest column's right edge, in px
    if (this.newestColTotal > 0) {
      xEnd = r.x + r.w + (this.newestColTotal - this.curTotal + dSamples) * pxPerSample;
      xEnd = Math.max(Math.min(xEnd, r.x + 2 * r.w), r.x);
    }
    const ringW = COLS * this.colPeriodSamples * pxPerSample; // >= r.w + D px
    const xStart = xEnd - ringW;

    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    const wNew = this.writeCol;            // columns 0..writeCol-1 are newest chunk's tail
    const wOld = COLS - wNew;
    if (wOld > 0) {
      ctx.drawImage(this.img, wNew, 0, wOld, ROWS, xStart, r.y, (wOld / COLS) * ringW, r.h);
    }
    if (wNew > 0) {
      ctx.drawImage(this.img, 0, 0, wNew, ROWS, xStart + (wOld / COLS) * ringW, r.y, (wNew / COLS) * ringW, r.h);
    }
    // uncovered strips (right: not yet computed; left: ring shorter than the
    // span after a rebuild): paint as silence, not page bg
    const lut = this.lut;
    ctx.fillStyle = `rgb(${lut[0]}, ${lut[1]}, ${lut[2]})`;
    if (xEnd < r.x + r.w) ctx.fillRect(xEnd, r.y, r.x + r.w - xEnd, r.h);
    if (xStart > r.x) ctx.fillRect(r.x, r.y, xStart - r.x, r.h);
    ctx.restore();

    // frame + labels, no grid over the image
    const axisOpts = {
      xLabel: 'time · s',
      yLabel: 'frequency · Hz',
      xFmt: (v) => (L.compact && Math.abs(v) < 1e-6 ? '' : Math.abs(v % 1) < 1e-6 ? v.toFixed(0) : v.toFixed(1)),
      xUnit: L.compact ? '0 s' : '',
      yFmt: fmtHz,
      yInside: L.yInside,
      xTitle: L.xTitle,
      yTitle: L.yTitle,
      theme: { grid: 'transparent', gridStrong: 'transparent' },
    };
    this.axes.draw(ctx, axisOpts);
    if (L.yInside) this.axes.drawInsideLabels(ctx, axisOpts);

    // colour-scale + latency note, bottom-right inside the plot on a tag so
    // it reads over the image and stays clear of the corner label and HUD
    const th = plotTheme();
    const range = `${s.get('sgFloorDb')}…${s.get('sgCeilDb')} dBFS`;
    const delay = this.isCwt && this.displayDelaySec ? `−${this.displayDelaySec.toFixed(2)} s` : '';
    const coarse = this.isCwt && this.cwtSkip > 1 ? `${this.cwtSkip}× step` : '';
    const parts = L.compact
      ? [delay, coarse].filter(Boolean)
      : [this.isCwt ? 'CWT' : '', delay ? `display ${delay}` : '', coarse, `${range} amplitude`].filter(Boolean);
    const note = parts.join(' · ');
    if (note) {
      ctx.font = '500 10px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      const tw = ctx.measureText(note).width + 10;
      const nx = r.x + r.w - 6;
      const ny = r.y + r.h - 12;
      ctx.fillStyle = th.tagBg;
      ctx.fillRect(nx - tw, ny - 8, tw, 16);
      ctx.fillStyle = th.title;
      ctx.fillText(note, nx - 5, ny + 0.5);
    }

    if (hover && this.axes.inRect(hover.x, hover.y)) {
      const freq = this.axes.pxToY(hover.y);
      const time = this.axes.pxToX(hover.x);
      const freqTxt = freq >= 1000 ? `${(freq / 1000).toFixed(2)} kHz` : `${freq.toFixed(0)} Hz`;
      const text = `${time.toFixed(2)} s  ${freqTxt}`;
      ctx.font = th.tagFont;
      const tw = ctx.measureText(text).width + 14;
      const bx = Math.min(hover.x + 12, r.x + r.w - tw - 4);
      const by = Math.max(hover.y - 30, r.y + 4);
      ctx.fillStyle = th.tagBg;
      ctx.fillRect(bx, by, tw, 20);
      ctx.strokeStyle = th.tagBorder;
      ctx.strokeRect(bx + 0.5, by + 0.5, tw - 1, 19);
      ctx.fillStyle = th.text;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, bx + 7, by + 10);
    }
  }
}
