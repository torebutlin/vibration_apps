// Spectrogram view: scrolling time-frequency heatmap.
//
// Two engines:
//   STFT — windowed FFT columns on a fixed column clock (span/COLS seconds
//          per column), sampled onto display rows per the freq axis.
//   CWT  — streaming Morlet scaleogram from a Web Worker: the view pushes
//          the new samples every frame, the worker returns one set of scale
//          values per hop on the audio clock. A slow device gets coarser
//          time steps (repeated columns), never a stall.
//
// Each wavelet needs 4 sigma of signal after the instant it reports on, and
// sigma falls as 1/f, so the rows do not become ready together: the treble
// is there almost at once, the bottom of the band trails by up to a second.
// Rather than hold every row back for the slowest, each row is drawn up to
// its own edge and the boundary is shown as a dashed curve — the
// uncertainty principle, to scale. Columns inside that live zone are
// repainted each frame as the rows fill in.
//
// A raw dB ring (COLS x ROWS) is kept alongside the pixel ring so colormap
// or range changes repaint the whole history, not just new columns.

import { rfftMagSq } from '../../../../shared/js/dsp/fft.js';
import { getWindow } from '../../../../shared/js/dsp/windows.js';
import { getColormap } from '../../../../shared/js/plot/colormap.js';
import { Axes, fmtHz, plotTheme, plotLayout } from '../../../../shared/js/plot/axes.js';
import { rowRanges, rowMax } from '../../../../shared/js/plot/rows.js';
import { freqRange, effectiveBinsPerOctave } from '../state.js';

const COLS = 1024;
const ROWS = 512;

// CWT display margin behind the fastest row's latency (seconds), so the
// newest columns are computed before their instants reach the right edge.
const CWT_MARGIN = 0.08;
// Audio already captured that a fresh worker is fed first, so the display
// fills from the left instead of starting empty. The wavelets need their
// own span twice over before the first column, so the worst row's latency
// sets how much; this is the floor and the cap.
const CWT_PREHISTORY = 1.0;
const CWT_PREHISTORY_MAX = 6.0;
// Below this the analysis edge is near enough vertical that a curve across
// it says nothing, so it is left off (the auditory law usually lands here).
const EDGE_MIN_PX = 10;

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
    this.lastPushed = null;   // engine sample count up to which audio has been sent
    this.cwtSkip = 1;         // worker's current time-step coarsening
    // per-scale lag in whole columns, and the rows' view of it
    this.cwtLagCols = null;
    this.cwtMinLagCols = 0;
    this.cwtMaxLagCols = 0;
    this.rowLagCols = new Int32Array(ROWS);
    this.cwtPrehistory = CWT_PREHISTORY;
    // scale values (dB) by column, a ring long enough for the live zone
    this.scaleRing = null;
    this.scaleRingCols = 0;
    this.scaleRingMask = 0;
    this.liveImage = null;
    this.cwtHead = null;      // newest column clock index the worker has sent
    this.cwtColTotal0 = 0;    // engine sample count at column 0
    this.paintedCol = -1;     // newest column painted into the image ring

    this.sinceCol = 0;      // samples since last emitted column (stft)
    this.lastTotal = 0;
    this.scratch = new Float32Array(1);
    this.windowed = null;
    this.power = null;
    this.dbCol = new Float32Array(ROWS);
    this.rowLo = null;      // per row: inclusive source bin/scale range
    this.rowHi = null;

    this.#rebuild();
    // only settings that change this engine's configuration restart it: the
    // FFT size is irrelevant to the wavelet, a manual bins value while Auto
    state.on(
      ['sgMode', 'sgSpan', 'fftSize', 'windowName', 'cwtBinsPerOctave', 'cwtBpoAuto', 'cwtOmega0', 'cwtBwLaw'],
      () => {
        if (this.#configKey() !== this.configKey) this.#rebuild();
      }
    );
    // The wavelet analyses the displayed range, so a new range restarts it;
    // a lin/log switch only remaps the rows onto the same scales.
    state.on(['freqScale', 'freqMin', 'freqMax', 'freqAuto'], () => {
      if (this.#configKey() !== this.configKey) {
        this.#rebuild();
      } else if (this.isCwt && this.workerReady) {
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

  /** Bins per octave in use (Auto follows the Q setting). */
  get binsPerOctave() {
    return effectiveBinsPerOctave(this.state);
  }

  /** The band the wavelet is analysing, for the settings readout. */
  get cwtRangeText() {
    const fr = this.#freqRange();
    return `${fmtHz(fr.min)}–${fmtHz(fr.max)} Hz`;
  }

  /** The settings the current engine was built from. The wavelet scales
   *  span the displayed range, so that range is part of its key; the STFT
   *  bins are the same whatever is on screen. */
  #configKey() {
    const s = this.state;
    const fr = this.#freqRange();
    const specific = this.isCwt
      ? [fr.min, fr.max, this.binsPerOctave, s.get('cwtOmega0'), s.get('cwtBwLaw')]
      : [s.get('fftSize'), s.get('windowName')];
    return [s.get('sgMode'), s.get('sgSpan'), this.sampleRate, ...specific].join('|');
  }

  /** Displayed frequency range — and, in wavelet mode, the range analysed. */
  #freqRange() {
    return freqRange(this.state, 'spectrogram', this.sampleRate);
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
    this.paintedCol = -1;
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
    // a row waits for the slowest scale it pools, which is its lowest
    for (let r = 0; r < ROWS; r++) this.rowLagCols[r] = this.cwtLagCols[lo[r]];
  }

  #rebuild() {
    const s = this.state;
    const fs = this.sampleRate;
    const fr = this.#freqRange();
    this.configKey = this.#configKey();
    // CWT: only the fastest row has to be computed before the right edge,
    // so the ring needs the span plus the margin, not the worst wavelet.
    // The worker reports the exact per-scale lags and column period once
    // it is configured.
    this.displayDelaySec = this.isCwt ? CWT_MARGIN : 0;
    this.colPeriodSamples = ((s.get('sgSpan') + (this.isCwt ? CWT_MARGIN + 0.5 : 0)) * fs) / COLS;
    this.sinceCol = 0;
    this.lastTotal = 0;
    this.newestColTotal = 0;
    this.curTotal = 0;
    this.cwtHead = null;
    this.#clearHistory();

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
    this.cwtHead = null;
    this.worker = new Worker(new URL('../workers/cwt-worker.js', import.meta.url), { type: 'module' });
    const s = this.state;
    this.worker.postMessage({
      type: 'config',
      sampleRate: this.sampleRate,
      fMin: fr.min,
      fMax: fr.max,
      binsPerOctave: this.binsPerOctave,
      omega0: s.get('cwtOmega0'),
      bandwidth: s.get('cwtBwLaw'),
      hopSamples: Math.round(this.colPeriodSamples),
    });
    this.worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'error') {
        console.error('CWT worker:', msg.message);
      } else if (msg.type === 'ready') {
        this.cwtFreqs = msg.freqs;
        this.cwtLagCols = Int32Array.from(msg.lagCols);
        this.cwtMinLagCols = Math.min(...msg.lagCols);
        this.cwtMaxLagCols = Math.max(...msg.lagCols);
        this.cwtMinLagSec = msg.minLagSeconds;
        this.cwtMaxLagSec = msg.maxLagSeconds;
        this.colPeriodSamples = msg.hop; // the worker's exact column period
        this.displayDelaySec = msg.minLagSeconds + CWT_MARGIN;
        // the widest wavelet needs its own span before and after the first
        // column, so feed the worker that much captured audio to start with
        this.cwtPrehistory = Math.min(
          Math.max(2 * msg.maxLagSeconds + 0.5, CWT_PREHISTORY),
          CWT_PREHISTORY_MAX,
          msg.ringSeconds * 0.9 // a push longer than the ring loses its head
        );
        this.#allocCwtRings(msg.freqs.length);
        this.#buildCwtRowMap();
        this.workerReady = true;
      } else if (msg.type === 'columns') {
        this.cwtSkip = msg.skip;
        this.cwtColTotal0 = msg.colTotal0;
        this.#ingestCwt(msg.data, msg.nCols, msg.headCol);
      }
    };
  }

  /** Scale ring long enough for the live zone plus a short stall, and the
   *  scratch image the live zone is painted through. */
  #allocCwtRings(nScales) {
    let cols = 64;
    while (cols < this.cwtMaxLagCols + 320) cols <<= 1;
    this.scaleRingCols = cols;
    this.scaleRingMask = cols - 1;
    this.scaleRing = new Float32Array(nScales * cols).fill(-160);
    const w = Math.min(COLS, cols);
    this.liveImage = this.imgCtx.createImageData(w, ROWS);
    this.paintedCol = -1;
  }

  /** Store one message of scale values, in dB, each at its own column. */
  #ingestCwt(data, nCols, headCol) {
    const nS = this.cwtFreqs.length;
    const ring = this.scaleRing;
    const mask = this.scaleRingMask;
    const first = headCol - nCols + 1;
    for (let j = 0; j < nS; j++) {
      const lag = this.cwtLagCols[j];
      const base = j * nCols;
      for (let k = 0; k < nCols; k++) {
        const col = first + k - lag;
        if (col < 0) continue;
        const a = data[base + k];
        ring[(col & mask) * nS + j] = 20 * Math.log10(a > 1e-12 ? a : 1e-12);
      }
    }
    this.cwtHead = headCol;
  }

  /**
   * Paint every column that can still change: from the newest fully
   * settled one out to the newest that has any data at all. Rows past
   * their own edge hold their newest value, so the dashed boundary has no
   * colour step across it once the image is scaled.
   */
  #paintCwtLive() {
    const head = this.cwtHead;
    if (head === null || !this.scaleRing || !this.rowLo) return;
    const newest = head - this.cwtMinLagCols;
    if (newest < 0) return;
    let from = Math.min(head - this.cwtMaxLagCols, this.paintedCol + 1);
    // never reach back past what the rings still hold
    from = Math.max(from, newest - (this.scaleRingCols - this.cwtMaxLagCols - 4));
    from = Math.max(from, newest - this.liveImage.width + 1, newest - COLS + 1, 0);
    if (newest < from) return;

    const W = this.liveImage.width;
    const px = this.liveImage.data;
    const lut = this.lut;
    const nS = this.cwtFreqs.length;
    const ring = this.scaleRing;
    const mask = this.scaleRingMask;
    const n = newest - from + 1;
    for (let x = 0; x < n; x++) {
      const col = from + x;
      const rawBase = (col & (COLS - 1)) * ROWS;
      for (let r = 0; r < ROWS; r++) {
        const edge = head - this.rowLagCols[r];
        const src = ((col < edge ? col : edge) & mask) * nS;
        let db = -160;
        for (let j = this.rowLo[r]; j <= this.rowHi[r]; j++) {
          const v = ring[src + j];
          if (v > db) db = v;
        }
        this.rawRing[rawBase + r] = db;
        const ci = this.#dbToColor(db) * 3;
        const o = (r * W + x) * 4;
        px[o] = lut[ci];
        px[o + 1] = lut[ci + 1];
        px[o + 2] = lut[ci + 2];
        px[o + 3] = 255;
      }
    }
    // the image ring wraps: at most two blits
    const dx = from & (COLS - 1);
    const firstRun = Math.min(n, COLS - dx);
    this.imgCtx.putImageData(this.liveImage, dx, 0, 0, 0, firstRun, ROWS);
    if (firstRun < n) {
      this.imgCtx.putImageData(this.liveImage, -firstRun, 0, firstRun, 0, n - firstRun, ROWS);
    }

    this.paintedCol = newest;
    this.writeCol = (newest + 1) & (COLS - 1);
    this.newestColTotal = this.cwtColTotal0 + newest * this.colPeriodSamples;
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
      // the rows fill in behind the head, so repaint the live zone even on
      // a frame that sends nothing new
      this.#paintCwtLive();
      // stream every new sample to the worker; it answers with columns
      if (this.lastPushed === null) {
        this.lastPushed = Math.max(0, total - Math.round(this.cwtPrehistory * this.sampleRate));
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

  /**
   * The analysis edge as a canvas path: x = now - 4 sigma(f) down the rows.
   * @param {boolean} close true closes it into the region left of the edge,
   *   for clipping; false leaves the bare curve, for stroking.
   */
  #edgePath(ctx, r, edgeX, close) {
    const STEPS = 64;
    const x0 = r.x;
    const x1 = r.x + r.w;
    ctx.beginPath();
    if (close) ctx.moveTo(x0, r.y);
    for (let k = 0; k <= STEPS; k++) {
      const row = Math.round((k / STEPS) * (ROWS - 1));
      const y = r.y + (row / (ROWS - 1)) * r.h;
      const x = Math.min(Math.max(edgeX(row), x0), x1);
      if (!close && k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    if (close) {
      ctx.lineTo(x0, r.y + r.h);
      ctx.closePath();
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
    const th = plotTheme();

    // Smooth scrolling on the audio clock. The plot maps display time
    // [now - D - span, now - D] where D is the display delay: 0 for the
    // STFT, and for the wavelet only the fastest row's lag plus the margin,
    // since the slower rows carry their own lag as a shorter reach.
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

    // The analysis edge: row by row, how far the wavelets have reached.
    const colPx = this.colPeriodSamples * pxPerSample;
    const edgeOn = this.isCwt && this.workerReady && this.cwtLagCols !== null;
    const edgeX = (row) => xEnd - (this.rowLagCols[row] - this.cwtMinLagCols) * colPx;
    const edgeSpreadPx = edgeOn ? (this.cwtMaxLagCols - this.cwtMinLagCols) * colPx : 0;

    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    if (edgeOn) {
      // ground for the corner no wavelet has reached yet — page, not the
      // colormap's silence, so it reads as "no answer" and not "nothing there"
      ctx.fillStyle = th.bg;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.save();
      this.#edgePath(ctx, r, edgeX, true);
      ctx.clip();
    }
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
    if (xEnd < r.x + r.w && !edgeOn) ctx.fillRect(xEnd, r.y, r.x + r.w - xEnd, r.h);
    if (xStart > r.x) ctx.fillRect(r.x, r.y, xStart - r.x, r.h);
    if (edgeOn) ctx.restore();
    // Only worth drawing where it says something: under the auditory law
    // the edge is all but vertical, and a curve there would be noise.
    if (edgeSpreadPx >= EDGE_MIN_PX) {
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = th.crosshair;
      ctx.lineWidth = 1;
      this.#edgePath(ctx, r, edgeX, false);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();

    // frame + labels, no grid over the image (th fetched above)
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
    const range = `${s.get('sgFloorDb')}…${s.get('sgCeilDb')} dBFS`;
    // the worst row's reach — the bottom of the band, where the dashed edge
    // bites deepest
    const worst = edgeOn ? this.cwtMaxLagSec : 0;
    const delay = worst >= 0.02 ? `−${worst.toFixed(2)} s` : '';
    const coarse = this.isCwt && this.cwtSkip > 1 ? `${this.cwtSkip}× step` : '';
    const parts = L.compact
      ? [delay, coarse].filter(Boolean)
      : [
          this.isCwt ? 'CWT' : '',
          delay ? `edge ${delay} at ${fmtHz(fr.min)} Hz` : '',
          coarse,
          `${range} amplitude`,
        ].filter(Boolean);
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
