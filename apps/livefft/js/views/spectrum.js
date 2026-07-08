// Spectrum view: live FFT / PSD with averaging, peak hold, peak labels,
// optional phosphor persistence, multi-resolution mode, crosshair readout.

import { SpectrumProcessor } from '../../../../shared/js/dsp/spectrum.js';
import { MultiResSpectrum } from '../../../../shared/js/dsp/multires.js';
import { findPeaks } from '../../../../shared/js/dsp/peaks.js';
import { Axes, fmtHz, plotTheme } from '../../../../shared/js/plot/axes.js';

// The spectrum shows PSD only: with averaging off it's the live FFT
// (instantaneous periodogram); averaging turns it into a Welch estimate.
const QUANTITY = 'psd';

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
    // auto-range state: expand instantly, hold while data is near the top,
    // release slowly (see #trackAutoRange)
    this.autoTop = -20;         // dB mode ceiling
    this.autoMaxLin = 1;        // linear mode ceiling
    this.lastNearTop = 0;
    this.lastRangeTick = 0;
    this.dominantPeak = null;   // {freq, db} for the header readout
    this.#configure();

    state.on(['fftSize', 'windowName', 'resMode'], () => this.#configure());
    state.on(['avgMode', 'expTimeConst', 'linearTarget'], () => this.#applyAveraging());
    state.on('dB', () => this.clearPersistence());
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
  }

  resetPeakHold() {
    this.proc.resetPeakHold();
    this.multi.resetPeakHold();
  }

  clearPersistence() {
    if (this.persistCanvas) {
      this.persistCanvas.getContext('2d').clearRect(0, 0, this.persistCanvas.width, this.persistCanvas.height);
    }
  }

  get avgProgress() {
    if (this.state.get('avgMode') !== 'linear') return null;
    if (this.state.get('resMode') === 'multires') return this.multi.linearProgress;
    return { count: this.proc.avgCount, target: this.proc.linearTarget, done: this.proc.linearDone };
  }

  /** Pull newest samples and update the processors. */
  tick(engine, dt) {
    const multires = this.state.get('resMode') === 'multires';
    const need = multires ? this.multi.maxSize : this.proc.fftSize;
    if (need > this.scratch.length) this.scratch = new Float32Array(need);
    const view = this.scratch.subarray(0, need);
    if (!engine.read(need, view)) return;
    if (multires) {
      this.multi.process(view, dt);
    } else {
      this.proc.process(view, dt);
    }
  }

  /** Current frequency range honouring auto/manual state. */
  #freqRange() {
    const s = this.state;
    const fs = this.sampleRate ?? 48000;
    const log = s.get('freqScale') === 'log';
    if (s.get('freqAuto')) return { min: log ? 20 : 0, max: fs / 2, log };
    let min = s.get('freqMin');
    let max = Math.min(s.get('freqMax'), fs / 2);
    if (log) min = Math.max(min, 1);
    return { min, max, log };
  }

  render(ctx, w, h, hover, rubberBand) {
    const s = this.state;
    const dB = s.get('dB');
    const quantity = QUANTITY;
    const multires = s.get('resMode') === 'multires';
    const fr = this.#freqRange();

    // layout
    const m = { l: 64, r: 14, t: 14, b: 46 };
    this.axes.setRect(m.l, m.t, w - m.l - m.r, h - m.t - m.b);
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

    const rangeArrays = peakSegments ? [...segments, ...peakSegments] : segments;
    const scanPeak = (init) => {
      let peak = init;
      for (const seg of rangeArrays) {
        for (let i = 0; i < seg.values.length; i++) {
          const f = (seg.startBin + i) * seg.binHz;
          if (f >= fr.min && f <= fr.max && seg.values[i] > peak) peak = seg.values[i];
        }
      }
      return peak;
    };

    // y range
    let yMin;
    let yMax;
    if (dB) {
      if (s.get('ampAuto')) {
        // required ceiling: 6 dB headroom, quantized to 5 dB steps
        const peak = scanPeak(-160);
        const required = Math.max(Math.min(Math.ceil((peak + 6) / 5) * 5, 20), -60);
        this.autoTop = this.#trackAutoRange(this.autoTop, required, 12);
        yMax = this.autoTop;
        yMin = this.autoTop - 110;
      } else {
        yMin = s.get('ampMin');
        yMax = s.get('ampMax');
      }
    } else {
      const peak = scanPeak(0);
      const required = Math.max(peak * 1.15, 1e-12);
      this.autoMaxLin = this.#trackAutoRange(this.autoMaxLin, required, this.autoMaxLin * 0.5);
      yMin = 0;
      yMax = this.autoMaxLin;
    }
    this.axes.setY(yMin, yMax, false);

    // grid + labels
    ctx.clearRect(0, 0, w, h);
    const qLabel = dB ? 'PSD · dBFS/Hz' : 'PSD · FS²/Hz';
    this.axes.draw(ctx, {
      xLabel: 'frequency · Hz',
      yLabel: qLabel,
      yFmt: dB ? (v) => v.toFixed(0) : undefined,
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

    // instantaneous ghost trace (averaging on)
    const showGhost = s.get('avgMode') !== 'off';
    if (showGhost) {
      if (multires) {
        this.#stroke(ctx, this.multi.segments(quantity, dB, 'inst'), th.traceGhost, 1);
      } else {
        this.proc.toDisplay(this.proc.power, this.instDisplay, quantity, dB);
        this.#stroke(ctx, [{ binHz: this.proc.binHz, startBin: 0, values: this.instDisplay }], th.traceGhost, 1);
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

    legend.push({ color: th.traceMain, label: s.get('avgMode') === 'off' ? 'live' : 'average' });
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
    if (legend.length > 1 || s.get('peakHold')) this.#drawLegend(ctx, legend, th);

    // peak labels follow the slowest-changing trace: the held maxima when
    // peak hold is on, otherwise the displayed (averaged or live) spectrum
    this.dominantPeak = null;
    const nLabels = s.get('peakLabels');
    if (nLabels > 0) {
      this.#drawPeakLabels(ctx, peakHoldActive ? peakSegments : segments, dB, nLabels, th);
    }

    // rubber band
    if (rubberBand) {
      ctx.fillStyle = 'rgba(56, 225, 200, 0.08)';
      ctx.strokeStyle = 'rgba(56, 225, 200, 0.4)';
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

  /**
   * Attack / hold / release for the auto range ceiling:
   *  - never clip: expand to `required` immediately;
   *  - hold while the data peak stays within `holdBand` of the ceiling;
   *  - after 1.5 s below that, settle down slowly (tau 2.5 s) so the data
   *    refills the plot without the axis jumping around.
   */
  #trackAutoRange(current, required, holdBand) {
    const now = performance.now();
    const dt = Math.min((now - this.lastRangeTick) / 1000, 0.1);
    this.lastRangeTick = now;
    if (required >= current) {
      this.lastNearTop = now;
      return required;
    }
    if (required > current - holdBand) {
      this.lastNearTop = now;
      return current;
    }
    if (now - this.lastNearTop < 1500) return current;
    return current + (1 - Math.exp(-dt / 2.5)) * (required - current);
  }

  #drawLegend(ctx, entries, th) {
    const r = this.axes.rect;
    ctx.save();
    ctx.font = '500 10px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    let x = r.x + 12;
    const y = r.y + 12;
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
    }
    const pc = this.persistCanvas.getContext('2d');
    const dpr = ctx.canvas.width / w;
    pc.setTransform(dpr, 0, 0, dpr, 0, 0);
    // fade history
    pc.globalCompositeOperation = 'destination-out';
    pc.fillStyle = 'rgba(0, 0, 0, 0.045)';
    pc.fillRect(0, 0, w, h);
    // add current trace ('lighter' glows on dark; plain alpha build-up on light)
    pc.globalCompositeOperation = th.persistComp;
    pc.strokeStyle = th.persistColor;
    pc.lineWidth = 1.4;
    this.#tracePath(pc, seg);
    pc.stroke();
    ctx.drawImage(this.persistCanvas, 0, 0, w, h);
  }

  #tracePath(ctx, seg) {
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
      const px = ax.xToPx(Math.max(f, 1e-3));
      const py = ax.yToPx(values[i]);
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else {
        ctx.lineTo(px, py);
      }
    }
  }

  #stroke(ctx, segments, color, width) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    for (const seg of segments) {
      this.#tracePath(ctx, seg);
      ctx.stroke();
    }
  }

  #drawPeakLabels(ctx, segments, dB, nLabels, th) {
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

    ctx.font = '500 11px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    let lastLabelX = -Infinity;
    let stagger = 0;
    for (const p of chosen) {
      const px = this.axes.xToPx(p.freq);
      const py = this.axes.yToPx(p.value);
      const label = p.freq >= 1000 ? `${(p.freq / 1000).toFixed(2)}k` : p.freq.toFixed(1);
      const tw = ctx.measureText(label).width + 10;
      stagger = px - lastLabelX < tw + 6 ? (stagger + 1) % 3 : 0;
      const ly = Math.max(py - 12 - stagger * 15, this.axes.rect.y + 14);
      // marker
      ctx.fillStyle = th.tracePeak;
      ctx.beginPath();
      ctx.arc(px, py, 2.5, 0, Math.PI * 2);
      ctx.fill();
      // leader
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = th.tracePeak;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, py - 4);
      ctx.lineTo(px, ly - 11);
      ctx.stroke();
      // tag
      ctx.globalAlpha = 1;
      ctx.fillStyle = th.tagBg;
      ctx.fillRect(px - tw / 2, ly - 24, tw, 15);
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = th.tracePeak;
      ctx.strokeRect(px - tw / 2 + 0.5, ly - 23.5, tw - 1, 14);
      ctx.globalAlpha = 1;
      ctx.fillStyle = th.tracePeak;
      ctx.fillText(label, px, ly - 11);
      lastLabelX = px;
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
