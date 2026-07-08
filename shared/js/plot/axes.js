// Canvas axes: linear/log scales, nice ticks, grid, labels.
// All drawing in CSS pixels — caller scales the context for devicePixelRatio.

const FONTS = {
  font: '11px "JetBrains Mono", monospace',
  titleFont: '600 11px Rajdhani, sans-serif',
  tagFont: '500 11px "JetBrains Mono", monospace',
};

// Plot colours come from the CSS custom properties in shared/css/theme.css,
// so the canvas follows the active light/dark theme. Cached per theme.
let cachedTheme = null;

export function plotTheme() {
  if (cachedTheme) return cachedTheme;
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  cachedTheme = {
    ...FONTS,
    grid: v('--plot-grid', 'rgba(158,178,216,0.07)'),
    gridStrong: v('--plot-grid-strong', 'rgba(158,178,216,0.14)'),
    frame: v('--plot-frame', 'rgba(158,178,216,0.25)'),
    label: v('--plot-label', '#8391ab'),
    title: v('--plot-title', '#56617a'),
    text: v('--plot-text', '#d9e2f4'),
    crosshair: v('--plot-crosshair', 'rgba(217,226,244,0.25)'),
    traceMain: v('--trace-main', '#3fe8d2'),
    traceGhost: v('--trace-ghost', 'rgba(63,232,210,0.28)'),
    tracePeak: v('--trace-peak', '#ffb454'),
    tagBg: v('--plot-tag-bg', 'rgba(13,17,25,0.85)'),
    tagBorder: v('--plot-tag-border', 'rgba(158,178,216,0.3)'),
    persistColor: v('--plot-persist-color', 'rgba(63,232,210,0.05)'),
    persistComp: v('--plot-persist-comp', 'lighter'),
  };
  return cachedTheme;
}

if (typeof document !== 'undefined') {
  new MutationObserver(() => {
    cachedTheme = null;
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

/** Format a frequency-like value compactly: 850, 1.2k, 12.5k */
export function fmtHz(v) {
  if (Math.abs(v) >= 1000) {
    const k = v / 1000;
    return `${k >= 100 ? k.toFixed(0) : k >= 10 ? +k.toFixed(1) : +k.toFixed(2)}k`;
  }
  if (Math.abs(v) >= 10) return `${+v.toFixed(0)}`;
  return `${+v.toFixed(2)}`;
}

/** Format a general value with sensible precision. */
export function fmtVal(v) {
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e4 || a < 1e-3) return v.toExponential(1);
  if (a >= 100) return v.toFixed(0);
  if (a >= 1) return +v.toFixed(2) + '';
  return +v.toFixed(4) + '';
}

export class Axes {
  constructor() {
    this.rect = { x: 40, y: 8, w: 100, h: 100 };
    this.x = { min: 0, max: 1, log: false };
    this.y = { min: 0, max: 1, log: false };
  }

  setRect(x, y, w, h) {
    this.rect = { x, y, w, h };
  }

  setX(min, max, log = false) {
    if (log) min = Math.max(min, 1e-3);
    this.x = { min, max, log };
  }

  setY(min, max, log = false) {
    this.y = { min, max, log };
  }

  // internal: value -> normalized 0..1 (0 = axis min)
  #norm(axis, v) {
    if (axis.log) {
      return (Math.log(v / axis.min)) / Math.log(axis.max / axis.min);
    }
    return (v - axis.min) / (axis.max - axis.min);
  }

  #denorm(axis, t) {
    if (axis.log) return axis.min * Math.pow(axis.max / axis.min, t);
    return axis.min + t * (axis.max - axis.min);
  }

  xToPx(v) { return this.rect.x + this.#norm(this.x, v) * this.rect.w; }
  yToPx(v) { return this.rect.y + (1 - this.#norm(this.y, v)) * this.rect.h; }
  pxToX(px) { return this.#denorm(this.x, (px - this.rect.x) / this.rect.w); }
  pxToY(px) { return this.#denorm(this.y, 1 - (px - this.rect.y) / this.rect.h); }

  inRect(px, py) {
    const r = this.rect;
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  }

  /** Linear ticks with a 1/2/5 progression, targeting ~`spacingPx` apart. */
  static linTicks(min, max, lengthPx, spacingPx = 60) {
    const targetCount = Math.max(2, lengthPx / spacingPx);
    const rawStep = (max - min) / targetCount;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    let step = mag;
    for (const m of [1, 2, 5, 10]) {
      if (mag * m >= rawStep) { step = mag * m; break; }
    }
    const ticks = [];
    const start = Math.ceil(min / step) * step;
    for (let v = start; v <= max + step * 1e-9; v += step) {
      ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    }
    return { major: ticks, minor: [] };
  }

  /** Log ticks: decade majors with 2–9 minors; falls back to 1-2-5 when zoomed. */
  static logTicks(min, max) {
    const major = [];
    const minor = [];
    const d0 = Math.floor(Math.log10(min));
    const d1 = Math.ceil(Math.log10(max));
    for (let d = d0; d <= d1; d++) {
      const base = Math.pow(10, d);
      if (base >= min && base <= max) major.push(base);
      for (let m = 2; m <= 9; m++) {
        const v = m * base;
        if (v >= min && v <= max) minor.push(v);
      }
    }
    // if very few decades visible, promote 2 and 5 to labelled majors
    if (major.length <= 2) {
      for (const v of [...minor]) {
        const lead = +v.toPrecision(1).toString()[0];
        if (lead === 2 || lead === 5) major.push(v);
      }
      major.sort((a, b) => a - b);
    }
    return { major, minor };
  }

  ticksX(spacingPx = 70) {
    return this.x.log
      ? Axes.logTicks(this.x.min, this.x.max)
      : Axes.linTicks(this.x.min, this.x.max, this.rect.w, spacingPx);
  }

  ticksY(spacingPx = 40) {
    return this.y.log
      ? Axes.logTicks(this.y.min, this.y.max)
      : Axes.linTicks(this.y.min, this.y.max, this.rect.h, spacingPx);
  }

  /**
   * Draw grid, frame and tick labels.
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} opts { xLabel, yLabel, xFmt, yFmt, theme }
   */
  draw(ctx, opts = {}) {
    const t = { ...plotTheme(), ...(opts.theme || {}) };
    const { x: rx, y: ry, w, h } = this.rect;
    const xFmt = opts.xFmt || fmtHz;
    const yFmt = opts.yFmt || fmtVal;

    const tx = this.ticksX();
    const ty = this.ticksY();

    ctx.save();
    ctx.lineWidth = 1;

    // minor grid
    ctx.strokeStyle = t.grid;
    ctx.beginPath();
    for (const v of tx.minor) {
      const px = Math.round(this.xToPx(v)) + 0.5;
      ctx.moveTo(px, ry);
      ctx.lineTo(px, ry + h);
    }
    for (const v of ty.minor) {
      const py = Math.round(this.yToPx(v)) + 0.5;
      ctx.moveTo(rx, py);
      ctx.lineTo(rx + w, py);
    }
    ctx.stroke();

    // major grid
    ctx.strokeStyle = t.gridStrong;
    ctx.beginPath();
    for (const v of tx.major) {
      const px = Math.round(this.xToPx(v)) + 0.5;
      ctx.moveTo(px, ry);
      ctx.lineTo(px, ry + h);
    }
    for (const v of ty.major) {
      const py = Math.round(this.yToPx(v)) + 0.5;
      ctx.moveTo(rx, py);
      ctx.lineTo(rx + w, py);
    }
    ctx.stroke();

    // frame
    ctx.strokeStyle = t.frame;
    ctx.strokeRect(Math.round(rx) + 0.5, Math.round(ry) + 0.5, Math.round(w) - 1, Math.round(h) - 1);

    // labels
    ctx.fillStyle = t.label;
    ctx.font = t.font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const v of tx.major) {
      const px = this.xToPx(v);
      if (px >= rx - 2 && px <= rx + w + 2) ctx.fillText(xFmt(v), px, ry + h + 5);
    }
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of ty.major) {
      const py = this.yToPx(v);
      if (py >= ry - 2 && py <= ry + h + 2) ctx.fillText(yFmt(v), rx - 7, py);
    }

    // axis titles
    ctx.fillStyle = t.title;
    ctx.font = t.titleFont;
    if (opts.xLabel) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(opts.xLabel.toUpperCase(), rx + w / 2, ry + h + 34);
    }
    if (opts.yLabel) {
      ctx.save();
      ctx.translate(rx - 44, ry + h / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(opts.yLabel.toUpperCase(), 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }
}
