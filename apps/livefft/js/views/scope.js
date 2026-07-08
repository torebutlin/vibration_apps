// Scope view: time-domain trace with optional rising-edge trigger for a
// stable display, plus RMS / peak level readouts.

import { Axes, plotTheme } from '../../../../shared/js/plot/axes.js';

export class ScopeView {
  constructor(state) {
    this.state = state;
    this.axes = new Axes();
    this.sampleRate = 48000;
    this.buf = new Float32Array(1);
    this.rms = 0;
    this.peak = 0;
  }

  setSampleRate(fs) {
    this.sampleRate = fs;
  }

  tick(engine, _dt) {
    const span = this.state.get('scopeSpan');
    const n = Math.floor(span * this.sampleRate);
    const total = 2 * n;
    if (this.buf.length !== total) this.buf = new Float32Array(total);
    this.have = engine.read(total, this.buf);

    if (this.have) {
      let sumSq = 0;
      let peak = 0;
      for (let i = n; i < total; i++) {
        const v = this.buf[i];
        sumSq += v * v;
        const a = Math.abs(v);
        if (a > peak) peak = a;
      }
      // smooth the readouts a little
      const rmsNow = Math.sqrt(sumSq / n);
      this.rms += 0.3 * (rmsNow - this.rms);
      this.peak = Math.max(peak, this.peak * 0.94);
    }
  }

  /** Find the start index for a stable display window. */
  #triggerIndex(n) {
    if (!this.state.get('scopeTrigger')) return n;
    const buf = this.buf;
    const thresh = Math.max(this.peak * 0.1, 0.005);
    // search backward from centre for a rising crossing of 0
    for (let i = n; i > 1; i--) {
      if (buf[i - 1] < -thresh * 0.2 && buf[i] >= 0 && buf[i] - buf[i - 1] > 0) {
        // require signal actually crosses threshold soon after
        return i;
      }
    }
    return n;
  }

  render(ctx, w, h, hover) {
    const th = plotTheme();
    const span = this.state.get('scopeSpan');
    const n = Math.floor(span * this.sampleRate);
    const useMs = span < 1;
    const xMax = useMs ? span * 1000 : span;
    const m = { l: 64, r: 14, t: 14, b: 46 };
    this.axes.setRect(m.l, m.t, w - m.l - m.r, h - m.t - m.b);
    this.axes.setX(0, xMax, false);

    // y auto: generous headroom, min +-0.01
    const yr = Math.max(this.peak * 1.3, 0.01);
    this.axes.setY(-yr, yr, false);

    ctx.clearRect(0, 0, w, h);
    this.axes.draw(ctx, {
      xLabel: useMs ? 'time · ms' : 'time · s',
      yLabel: 'signal · full scale',
      xFmt: (v) => (span < 0.02 || !useMs ? +v.toFixed(1) + '' : v.toFixed(0)),
      yFmt: (v) => (yr < 0.1 ? v.toFixed(3) : v.toFixed(2)),
    });

    const r = this.axes.rect;
    if (!this.have) return;

    const start = this.#triggerIndex(n);
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();

    // zero line
    ctx.strokeStyle = th.gridStrong;
    ctx.lineWidth = 1;
    const zy = Math.round(this.axes.yToPx(0)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(r.x, zy);
    ctx.lineTo(r.x + r.w, zy);
    ctx.stroke();

    // trace: step through samples, decimate to ~2 points per px
    ctx.strokeStyle = th.traceMain;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const step = Math.max(1, Math.floor(n / (r.w * 2)));
    for (let i = 0; i < n; i += step) {
      const px = r.x + (i / n) * r.w;
      const py = this.axes.yToPx(this.buf[start + i]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();

    // level readout
    const rmsDb = 20 * Math.log10(Math.max(this.rms, 1e-9));
    const peakDb = 20 * Math.log10(Math.max(this.peak, 1e-9));
    ctx.font = th.tagFont;
    ctx.fillStyle = th.label;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(`rms ${rmsDb.toFixed(1)} dBFS   peak ${peakDb.toFixed(1)} dBFS`, r.x + r.w - 6, r.y + 6);

    if (hover && this.axes.inRect(hover.x, hover.y)) {
      const t = this.axes.pxToX(hover.x);
      const idx = Math.round((t / xMax) * n);
      const v = this.buf[Math.min(start + idx, this.buf.length - 1)];
      const text = `${t.toFixed(2)} ${useMs ? 'ms' : 's'}  ${v.toFixed(4)}`;
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
