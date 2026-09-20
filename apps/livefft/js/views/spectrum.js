// Spectrum view: live FFT / PSD with averaging, peak hold, peak labels,
// optional phosphor persistence, multi-resolution mode, crosshair readout.

import { SpectrumProcessor } from '../../../../shared/js/dsp/spectrum.js';
import { MultiResSpectrum } from '../../../../shared/js/dsp/multires.js';
import { findPeaks } from '../../../../shared/js/dsp/peaks.js';
import { Axes, fmtHz, plotTheme, plotLayout } from '../../../../shared/js/plot/axes.js';
import { AxisLimit, axisCeiling, levelStats } from '../../../../shared/js/plot/autorange.js';
import { FrameHopper } from '../../../../shared/js/dsp/hop.js';
import { freqRange } from '../state.js';

// The spectrum shows PSD only: with averaging off it's the live FFT
// (instantaneous periodogram); averaging turns it into a Welch estimate.
const QUANTITY = 'psd';

// Frames advance every HOP_MAX samples (21 ms at 48 kHz) or every half
// FFT if that is shorter, so long FFTs still animate smoothly. Frames
// closer than half an FFT are correlated, so they count fractionally
// towards "N averages" (weight = hop / (N/2)). Matched to the capture
// batch, which is what actually paces the display.
const HOP_MAX = 1024;

// Auto range (dB). The axis is fitted to the bold traces — the displayed
// spectrum, plus peak hold when it is on. The instantaneous ghost is left
// out on purpose: individual bins of a single periodogram swing tens of dB
// from frame to frame, and an axis that made room for every dip would keep
// the averaged trace squashed into the top of the plot. The ghost is
// clipped instead, at both ends.
const AUTO_SPAN_MIN = 40;      // dB: never a tighter axis than this
const AUTO_SPAN_MAX = 120;     // dB: nor a wider one
const AUTO_FLOOR_TAIL = 0.02;  // fraction of bins allowed below the floor
const AUTO_FLOOR_MARGIN = 8;   // dB of clearance under the floor level
const LEVEL_DEPTH = 160;       // dB below the peak the floor can be found
const AUTO_TOP_MAX = 20;       // dB: the ceiling stops above full scale
const AUTO_TOP_MIN = -140;     // dB: and below any converter's noise floor

function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export class SpectrumView {
  constructor(state) {
    this.state = state;
    this.axes = new Axes();
    this.proc = null;
    this.multi = null;
    this.scratch = null;
    this.display = null;        // Float32Array, standard mode
    this.peakDisplay = null;
    this.instDisplay = null;
    this.persistCanvas = null;
    this.persistKey = null;     // axis geometry the phosphor was drawn for
    // Auto range: one limit per end of the y axis (see AxisLimit). Both
    // give ground back once the data has left a gap wider than the grid
    // they are quantized to — one 5 dB step at the floor, two at the
    // ceiling, where a peak wanders more than the body of the trace does.
    this.autoTop = new AxisLimit(-20, +1, { holdBand: 10 });
    this.autoBottom = new AxisLimit(-130, -1, { holdBand: 5 });
    this.autoMaxLin = new AxisLimit(1, +1);      // linear ceiling
    this.levelHist = new Int32Array(LEVEL_DEPTH); // scratch for levelStats
    this.lastRangeTick = 0;
    this.snapRange = true;      // next frame jumps straight to the required range
    this.dataFrames = 0;        // frames processed since the average was reset
    this.dominantPeak = null;   // {freq, db} for the header readout
    this.hopper = new FrameHopper(HOP_MAX); // frames advance on samples, not display refresh
    this.lastProcAt = 0;
    this.#configure();

    state.on(['fftSize', 'windowName', 'resMode'], () => this.#configure());
    state.on(['avgMode', 'expTimeConst', 'linearTarget'], () => this.#applyAveraging());
    state.on('dB', () => {
      this.clearPersistence();
      this.snapRange = true;
    });
    // discontinuous display changes: re-range instantly, don't glide.
    // avgMode and peakHold belong here too — they change which traces the
    // range is fitted to, and how far down they reach.
    state.on(['freqMin', 'freqMax', 'freqAuto', 'freqScale', 'resMode', 'avgMode', 'peakHold', 'ampAuto'], () => {
      this.snapRange = true;
    });
    window.addEventListener('themechange', () => this.clearPersistence());
  }

  #configure() {
    const s = this.state;
    const fftSize = s.get('fftSize');
    const windowName = s.get('windowName');
    this.proc = new SpectrumProcessor({ fftSize, windowName, sampleRate: this.sampleRate ?? 48000 });
    // multires base size capped so 16N stays sane
    const base = Math.min(fftSize, 8192);
    this.multi = new MultiResSpectrum({ baseSize: base, windowName, sampleRate: this.sampleRate ?? 48000 });
    this.#applyAveraging();
    const need = Math.max(fftSize, this.multi.maxSize);
    this.scratch = new Float32Array(need);
    this.display = new Float32Array(this.proc.nBins);
    this.peakDisplay = new Float32Array(this.proc.nBins);
    this.instDisplay = new Float32Array(this.proc.nBins);
    this.clearPersistence();
    this.hopper?.reset();
    this.dataFrames = 0;
  }

  #applyAveraging() {
    const s = this.state;
    const opts = {
      expTimeConst: s.get('expTimeConst'),
      linearTarget: s.get('linearTarget'),
    };
    this.proc.setAveraging(s.get('avgMode'), opts);
    this.multi.setAveraging(s.get('avgMode'), {
      ...opts,
      expTimeConst: Math.max(opts.expTimeConst, 0.1),
    });
    this.dataFrames = 0; // setAveraging clears the averages: re-range on the next one
  }

  setSampleRate(fs) {
    if (fs !== this.sampleRate) {
      this.sampleRate = fs;
      this.#configure();
    }
  }

  resetAverage() {
    this.proc.resetAverage();
    this.multi.resetAverage();
    this.dataFrames = 0;
  }

  resetPeakHold() {
    this.proc.resetPeakHold();
    this.multi.resetPeakHold();
  }

  clearPersistence() {
    this.persistKey = null;
    if (this.persistCanvas) {
      const pc = this.persistCanvas.getContext('2d');
      pc.setTransform(1, 0, 0, 1, 0, 0);
      pc.clearRect(0, 0, this.persistCanvas.width, this.persistCanvas.height);
    }
  }

  get avgProgress() {
    if (this.state.get('avgMode') !== 'linear') return null;
    const p = this.state.get('resMode') === 'multires'
      ? this.multi.linearProgress
      : { count: this.proc.avgCount, target: this.proc.linearTarget, done: this.proc.linearFull };
    // counts are fractional (independent-frame weights); show whole averages
    return { count: Math.floor(p.count + 1e-9), target: p.target, done: p.done };
  }

  /** Pull newest samples and update the processors, once per hop of new
   *  samples (50% overlap) so averaging counts data frames, not display
   *  refreshes. */
  tick(engine, _dt) {
    const multires = this.state.get('resMode') === 'multires';
    const need = multires ? this.multi.maxSize : this.proc.fftSize;
    const base = multires ? this.multi.baseSize : this.proc.fftSize;
    const hop = Math.min(base >> 1, HOP_MAX);
    this.hopper.setHop(hop);
    if (!this.hopper.due(engine.totalSamples)) return;
    const now = performance.now();
    const dt = this.lastProcAt ? Math.min((now - this.lastProcAt) / 1000, 0.5) : 0;
    this.lastProcAt = now;
    if (need > this.scratch.length) this.scratch = new Float32Array(need);
    const view = this.scratch.subarray(0, need);
    if (!engine.read(need, view)) return;
    const weight = hop / (base / 2);
    if (multires) {
      this.multi.process(view, dt, weight);
    } else {
      this.proc.process(view, dt, weight);
    }
    // the display held nothing but the -300 dB floor until now: fit the
    // axis to the first real spectrum instead of gliding down from silence
    if (this.dataFrames++ === 0) this.snapRange = true;
  }

  /** Current frequency range honouring auto/manual state. */
  #freqRange() {
    return freqRange(this.state, 'spectrum', this.sampleRate ?? 48000);
  }

  render(ctx, w, h, hover, rubberBand, layout = {}) {
    const s = this.state;
    const dB = s.get('dB');
    const quantity = QUANTITY;
    const multires = s.get('resMode') === 'multires';
    const fr = this.#freqRange();

    // layout
    const L = plotLayout(w, h, layout);
    this.axes.setRect(L.rect.x, L.rect.y, L.rect.w, L.rect.h);
    this.axes.setX(fr.min, fr.max, fr.log);

    // gather display data
    let segments;
    if (multires) {
      segments = this.multi.segments(quantity, dB).map((seg) => ({
        binHz: seg.binHz,
        startBin: seg.startBin,
        values: seg.values,
        fLow: seg.fLow,
        fHigh: seg.fHigh,
      }));
    } else {
      this.proc.toDisplay(this.proc.avgPower, this.display, quantity, dB);
      segments = [{ binHz: this.proc.binHz, startBin: 0, values: this.display }];
    }

    // Peak-hold display is computed up front so the auto range can include
    // it — the held trace (and its labels) must never sit off-scale.
    const peakHoldActive = s.get('peakHold') && (multires ? this.multi.peakValid : this.proc.peakValid);
    let peakSegments = null;
    if (peakHoldActive) {
      if (multires) {
        peakSegments = this.multi.segments(quantity, dB, 'peak');
      } else {
        this.proc.toDisplay(this.proc.peakPower, this.peakDisplay, quantity, dB);
        peakSegments = [{ binHz: this.proc.binHz, startBin: 0, values: this.peakDisplay }];
      }
    }

    // the bold traces — the ones the axis is fitted to
    const rangeArrays = peakSegments ? [...segments, ...peakSegments] : segments;

    // y range
    let yMin;
    let yMax;
    if (dB && !s.get('ampAuto')) {
      yMin = s.get('ampMin');
      yMax = s.get('ampMax');
    } else {
      const step = this.#rangeStep();
      const stats = levelStats(rangeArrays, fr.min, fr.max, {
        tail: AUTO_FLOOR_TAIL,
        depth: LEVEL_DEPTH,
        floor: dB,              // a linear axis is anchored at zero
        hist: this.levelHist,
      });
      if (dB) {
        // ceiling: headroom for the peak labels (more in big label mode),
        // quantized to 5 dB steps. It follows the peak wherever it goes, so
        // a quiet source fills the plot rather than hanging under a fixed
        // top; only full scale and the point where levels stop meaning
        // anything bound it.
        const headroom = s.get('labelSize') === 'big' ? 12 : 6;
        const peak = stats ? stats.peak : AUTO_TOP_MIN;
        const top = axisCeiling(peak, { headroom, min: AUTO_TOP_MIN, max: AUTO_TOP_MAX });
        yMax = this.autoTop.track(top, step);
        // floor: just under the body of the bold traces, so the plot is
        // filled by the measurement rather than by empty decades below it
        const low = stats ? stats.low : yMax - AUTO_SPAN_MAX;
        const bottom = Math.min(
          Math.max(Math.floor((low - AUTO_FLOOR_MARGIN) / 5) * 5, yMax - AUTO_SPAN_MAX),
          yMax - AUTO_SPAN_MIN
        );
        yMin = this.autoBottom.track(bottom, step);
        // the ceiling may have dropped faster than the floor has risen
        yMin = Math.min(yMin, yMax - AUTO_SPAN_MIN);
      } else {
        const required = Math.max((stats ? stats.peak : 0) * 1.15, 1e-12);
        yMax = this.autoMaxLin.track(required, step, this.autoMaxLin.value * 0.5);
        yMin = 0;
      }
    }
    this.axes.setY(yMin, yMax, false);

    // grid + labels
    ctx.clearRect(0, 0, w, h);
    const qLabel = dB ? 'PSD · dBFS/Hz' : 'PSD · FS²/Hz';
    this.axes.draw(ctx, {
      xLabel: 'frequency · Hz',
      yLabel: qLabel,
      xFmt: L.compact ? (v) => (v >= fr.max - 1e-6 ? '' : fmtHz(v)) : undefined,
      xUnit: L.compact ? 'Hz' : '',
      yFmt: dB ? (v) => v.toFixed(0) : undefined,
      yInside: L.yInside,
      xTitle: L.xTitle,
      yTitle: L.yTitle,
    });

    const r = this.axes.rect;

    const th = plotTheme();

    // clip to plot area for traces
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();

    // persistence layer
    if (s.get('persistence') && !multires) {
      this.#renderPersistence(ctx, w, h, segments[0], th);
    }

    const legend = [];

    // instantaneous ghost trace (averaging on) — drawn only where it is on
    // scale: the axis is fitted to the bold traces, and one periodogram
    // swings tens of dB either side of them
    const showGhost = s.get('avgMode') !== 'off';
    if (showGhost) {
      if (multires) {
        this.#stroke(ctx, this.multi.segments(quantity, dB, 'inst'), th.traceGhost, 1, true);
      } else {
        this.proc.toDisplay(this.proc.power, this.instDisplay, quantity, dB);
        this.#stroke(ctx, [{ binHz: this.proc.binHz, startBin: 0, values: this.instDisplay }], th.traceGhost, 1, true);
      }
    }

    // peak hold trace (display values computed above for the auto range)
    if (peakHoldActive) {
      this.#stroke(ctx, peakSegments, th.tracePeak, 1);
    }

    // main trace
    this.#stroke(ctx, segments, th.traceMain, 1.6);

    // multires echo lines: each stage carried past its boundary, fading
    // out, so the eye can follow the level across the discontinuities
    if (multires) {
      for (const e of this.multi.extensions(quantity, dB, 1.6)) {
        const x0 = this.axes.xToPx(e.fadeFromHz);
        const x1 = this.axes.xToPx(e.fadeToHz);
        if (!isFinite(x0) || !isFinite(x1) || Math.abs(x1 - x0) < 1) continue;
        const grad = ctx.createLinearGradient(x0, 0, x1, 0);
        grad.addColorStop(0, hexToRgba(th.traceMain, 0.35));
        grad.addColorStop(1, hexToRgba(th.traceMain, 0));
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1;
        this.#tracePath(ctx, e);
        ctx.stroke();
      }
    }

    legend.push({ color: th.traceMain, label: this.#mainTraceLabel() });
    if (showGhost) legend.push({ color: th.traceGhost, label: 'live' });
    if (peakHoldActive) legend.push({ color: th.tracePeak, label: 'peak hold' });

    // multires region boundaries
    if (multires) {
      ctx.strokeStyle = th.crosshair;
      ctx.setLineDash([3, 5]);
      for (const seg of segments) {
        if (seg.fLow > 0 && seg.fLow > fr.min && seg.fLow < fr.max) {
          const px = this.axes.xToPx(seg.fLow);
          ctx.beginPath();
          ctx.moveTo(px, r.y);
          ctx.lineTo(px, r.y + r.h);
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
    }

    ctx.restore();

    // trace legend (top-left) — identifies average / live / peak hold
    // bottom-left: the noise floor lives there, whereas peak tags crowd the top
    if (legend.length > 1 || s.get('peakHold')) this.#drawLegend(ctx, legend, th, true);

    // inside y labels go over the traces (phone portrait)
    if (L.yInside) this.axes.drawInsideLabels(ctx, { yLabel: qLabel, yFmt: dB ? (v) => v.toFixed(0) : undefined });

    // peak labels follow the slowest-changing trace: the held maxima when
    // peak hold is on, otherwise the displayed (averaged or live) spectrum
    this.dominantPeak = null;
    const nLabels = s.get('peakLabels');
    if (nLabels > 0) {
      this.#drawPeakLabels(ctx, peakHoldActive ? peakSegments : segments, dB, nLabels, th, w);
    }

    // rubber band
    if (rubberBand) {
      ctx.fillStyle = th.rubber;
      ctx.strokeStyle = th.rubberLine;
      const x0 = Math.max(rubberBand.x0, r.x);
      const x1 = Math.min(rubberBand.x1, r.x + r.w);
      ctx.fillRect(x0, r.y, x1 - x0, r.h);
      ctx.strokeRect(x0 + 0.5, r.y + 0.5, x1 - x0 - 1, r.h - 1);
    }

    // crosshair
    if (hover && this.axes.inRect(hover.x, hover.y)) {
      this.#drawCrosshair(ctx, hover, segments, dB, th);
    }
  }

  /** What the bold trace is: how many spectra the moving window is
   *  averaging, and while it is still filling, how far along it is. The
   *  readout that says the same is hidden on phones. */
  #mainTraceLabel() {
    const mode = this.state.get('avgMode');
    if (mode === 'off') return 'live';
    if (mode !== 'linear') return 'average';
    const p = this.avgProgress;
    return p.done ? `average · ${p.target}` : `average · ${p.count}/${p.target}`;
  }

  /** One tick of the auto-range clock, shared by both ends of the axis:
   *  the frame time, and whether this frame is a snap (a setting changed
   *  that makes gliding meaningless). */
  #rangeStep() {
    const now = performance.now();
    const dt = Math.min((now - this.lastRangeTick) / 1000, 0.1);
    this.lastRangeTick = now;
    const snap = this.snapRange;
    this.snapRange = false;
    return { now, dt, snap };
  }

  #drawLegend(ctx, entries, th, bottom = false) {
    const r = this.axes.rect;
    ctx.save();
    ctx.font = '500 10px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    let x = r.x + 12;
    // bottom-left when the y labels are inside (the top-left holds the quantity)
    const y = bottom ? r.y + r.h - 10 : r.y + 12;
    for (const e of entries) {
      ctx.strokeStyle = e.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 14, y);
      ctx.stroke();
      ctx.fillStyle = th.label;
      ctx.fillText(e.label, x + 19, y + 0.5);
      x += 19 + ctx.measureText(e.label).width + 16;
    }
    ctx.restore();
  }

  #renderPersistence(ctx, w, h, seg, th) {
    if (!this.persistCanvas || this.persistCanvas.width !== ctx.canvas.width || this.persistCanvas.height !== ctx.canvas.height) {
      this.persistCanvas = document.createElement('canvas');
      this.persistCanvas.width = ctx.canvas.width;
      this.persistCanvas.height = ctx.canvas.height;
      this.persistKey = null;
    }
    const pc = this.persistCanvas.getContext('2d');
    const dpr = ctx.canvas.width / w;
    pc.setTransform(dpr, 0, 0, dpr, 0, 0);
    // The phosphor is a picture in pixels, so it only means anything while
    // the axes stay put: once they move (the auto range settling, a zoom, a
    // resize) every old stroke is at the wrong level. Start again rather
    // than smear — the fade alone would not do it, as a canvas fading by a
    // fraction of an 8-bit alpha stalls a few percent short of clear.
    const ax = this.axes;
    const key = [ax.x.min, ax.x.max, ax.y.min, ax.y.max, ax.rect.x, ax.rect.y, ax.rect.w, ax.rect.h];
    const moved = !this.persistKey || key.some((v, i) => v !== this.persistKey[i]);
    this.persistKey = key;
    if (moved) {
      pc.clearRect(0, 0, w, h);
    } else {
      // fade history
      pc.globalCompositeOperation = 'destination-out';
      pc.fillStyle = 'rgba(0, 0, 0, 0.045)';
      pc.fillRect(0, 0, w, h);
    }
    // add current trace ('lighter' glows on dark; plain alpha build-up on light)
    pc.globalCompositeOperation = th.persistComp;
    pc.strokeStyle = th.persistColor;
    pc.lineWidth = 1.4;
    this.#tracePath(pc, seg);
    pc.stroke();
    ctx.drawImage(this.persistCanvas, 0, 0, w, h);
  }

  /**
   * Path along one segment of a trace.
   * @param {boolean} skipOffScale drop the bins that fall outside the y
   *   axis instead of letting the clip cut them off. The auto range follows
   *   the bold traces, so the live one swings past both ends; drawn whole
   *   it would leave a comb of vertical strokes along the edges of the plot.
   */
  #tracePath(ctx, seg, skipOffScale = false) {
    const { binHz, startBin, values } = seg;
    const ax = this.axes;
    ctx.beginPath();
    let started = false;
    const fMin = ax.x.min;
    const fMax = ax.x.max;
    for (let i = 0; i < values.length; i++) {
      const f = (startBin + i) * binHz;
      if (f < fMin - binHz || f > fMax + binHz) continue;
      if (ax.x.log && f <= 0) continue;
      const v = values[i];
      if (skipOffScale && (v < ax.y.min || v > ax.y.max)) {
        started = false;
        continue;
      }
      const px = ax.xToPx(Math.max(f, 1e-3));
      const py = ax.yToPx(v);
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else {
        ctx.lineTo(px, py);
      }
    }
  }

  #stroke(ctx, segments, color, width, skipOffScale = false) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    for (const seg of segments) {
      this.#tracePath(ctx, seg, skipOffScale);
      ctx.stroke();
    }
  }

  #drawPeakLabels(ctx, segments, dB, nLabels, th, w) {
    // collect candidate peaks across segments (multires: per segment)
    const all = [];
    for (const seg of segments) {
      // findPeaks expects dB-domain data
      let arr = seg.values;
      if (!dB) {
        arr = new Float32Array(seg.values.length);
        for (let i = 0; i < arr.length; i++) arr[i] = 20 * Math.log10(Math.max(seg.values[i], 1e-15));
      }
      const peaks = findPeaks(arr, nLabels, { startBin: seg.startBin === 0 ? 1 : 0 });
      for (const p of peaks) {
        const freq = (seg.startBin + p.bin + p.frac) * seg.binHz;
        if (freq < this.axes.x.min || freq > this.axes.x.max) continue;
        all.push({ freq, db: p.db, value: seg.values[p.bin] });
      }
    }
    all.sort((a, b) => b.db - a.db);
    const chosen = all.slice(0, nLabels).sort((a, b) => a.freq - b.freq);
    if (all.length > 0) {
      this.dominantPeak = { freq: all[0].freq, db: all[0].db };
    }

    // F scales everything for the lecture-display "big" mode
    const F = this.state.get('labelSize') === 'big' ? 2 : 1;
    ctx.font = `500 ${11 * F}px "JetBrains Mono", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    let lastLabelX = -Infinity;
    let stagger = 0;
    for (const p of chosen) {
      const px = this.axes.xToPx(p.freq);
      const py = this.axes.yToPx(p.value);
      const label = p.freq >= 1000 ? `${(p.freq / 1000).toFixed(2)}k` : p.freq.toFixed(1);
      const tw = ctx.measureText(label).width + 10 * F;
      stagger = px - lastLabelX < tw + 6 ? (stagger + 1) % 3 : 0;
      // clamp the tag fully inside the canvas: vertically (top edge) and
      // horizontally (leader slants when the tag can't sit over the peak)
      const ly = Math.max(py - 12 * F - stagger * 15 * F, 24 * F + 2);
      const lx = Math.min(Math.max(px, tw / 2 + 2), w - tw / 2 - 2);
      // marker
      ctx.fillStyle = th.tracePeak;
      ctx.beginPath();
      ctx.arc(px, py, 2.5 * F, 0, Math.PI * 2);
      ctx.fill();
      // leader
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = th.tracePeak;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, py - 4 * F);
      ctx.lineTo(lx, ly - 9 * F);
      ctx.stroke();
      // tag
      ctx.globalAlpha = 1;
      ctx.fillStyle = th.tagBg;
      ctx.fillRect(lx - tw / 2, ly - 24 * F, tw, 15 * F);
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = th.tracePeak;
      ctx.strokeRect(lx - tw / 2 + 0.5, ly - 24 * F + 0.5, tw - 1, 15 * F - 1);
      ctx.globalAlpha = 1;
      ctx.fillStyle = th.tracePeak;
      ctx.fillText(label, lx, ly - 11 * F);
      lastLabelX = lx;
    }
  }

  #drawCrosshair(ctx, hover, segments, dB, th) {
    const ax = this.axes;
    const r = ax.rect;
    const freq = ax.pxToX(hover.x);
    // find trace value at freq
    let value = null;
    for (const seg of segments) {
      const fLo = seg.startBin * seg.binHz;
      const fHi = (seg.startBin + seg.values.length - 1) * seg.binHz;
      if (freq >= fLo && freq <= fHi && (seg.fLow === undefined || (freq > (seg.fLow || 0) && freq <= (seg.fHigh || Infinity)))) {
        const idx = Math.round(freq / seg.binHz) - seg.startBin;
        if (idx >= 0 && idx < seg.values.length) value = seg.values[idx];
      }
    }

    ctx.save();
    ctx.strokeStyle = th.crosshair;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(hover.x + 0.5, r.y);
    ctx.lineTo(hover.x + 0.5, r.y + r.h);
    ctx.stroke();
    if (value !== null) {
      const py = ax.yToPx(value);
      ctx.beginPath();
      ctx.moveTo(r.x, py + 0.5);
      ctx.lineTo(r.x + r.w, py + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = th.traceMain;
      ctx.beginPath();
      ctx.arc(hover.x, py, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.setLineDash([]);

    // readout box
    const freqTxt = freq >= 1000 ? `${(freq / 1000).toFixed(3)} kHz` : `${freq.toFixed(1)} Hz`;
    const valTxt = value === null ? '' : dB ? `${value.toFixed(1)} dB` : value.toExponential(2);
    const text = valTxt ? `${freqTxt}  ${valTxt}` : freqTxt;
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
    ctx.restore();
  }

  /** Resolution text for the header readout. */
  get resolutionText() {
    if (this.state.get('resMode') === 'multires') {
      const st = this.multi.stages;
      return `${fmtHz(this.sampleRate / st[2].size)}–${fmtHz(this.sampleRate / st[0].size)} Hz`;
    }
    return `${(this.proc.binHz).toFixed(this.proc.binHz < 10 ? 2 : 1)} Hz`;
  }
}
