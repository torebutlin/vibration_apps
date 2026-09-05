# Live FFT UI Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `docs/specs/2026-09-05-livefft-ui-refresh-design.md`: quiet chrome on wide screens, floating pills plus a bottom sheet on phones, one ground per theme, the axis-label rule, and the ten verified accuracy fixes.

**Architecture:** Layout decisions (wide/narrow, portrait/landscape) are computed once in `main.js` and passed to the views as a `layout` object; a shared `plotLayout()` in `shared/js/plot/axes.js` turns it into margins and draw options so the three views and future demos share one rule. Pure helpers with tests carry the accuracy fixes: `rowRanges` (spectrogram row pooling), `FrameHopper` (sample-hopped averaging), `minMaxEnvelope` (scope). The DOM stays one tree: the same header, HUD and panel elements are restyled into pills and a sheet on narrow screens, with a few elements re-homed by JS.

**Tech Stack:** Vanilla ES modules, Canvas 2D, CSS custom properties, `node --test` for DSP/plot helpers. No build step.

---

## File map

| File | Responsibility |
|------|----------------|
| `shared/css/theme.css` | Tokens for both themes (new: `--pill`, `--sheet`, `--scrim`, rubber band, hover, glow), control primitives, narrow-screen control sizes. All colour literals live here. |
| `shared/js/plot/axes.js` | `plotLayout()` margins rule; `Axes.draw()` learns `yInside`, `xUnit`, `xTitle`, `yTitle`; `plotTheme()` exposes `bg`, `rubber`, `rubberLine`. |
| `shared/js/plot/rows.js` (new) | `rowRanges()` and `rowMax()` for heatmap rows that pool every source bin they cover. |
| `shared/js/plot/envelope.js` (new) | `minMaxEnvelope()` for the scope trace. |
| `shared/js/plot/colormap.js` | `getColormap(name, reversed, ground)` blends the light variant into the page ground. |
| `shared/js/plot/interaction.js` | New `onTap` callback (pointer up without drag). |
| `shared/js/dsp/hop.js` (new) | `FrameHopper`: process a frame only after `hop` new samples. |
| `shared/js/dsp/multires.js`, `windows.js` | Comment corrections only. |
| `shared/js/audio/capture-worklet.js` | Copies input to output so the monitor gain gets signal. |
| `apps/livefft/index.html` | New header/HUD/sheet/start-screen markup. |
| `apps/livefft/css/app.css` | Wide layout (rail), narrow layout (pills + sheet), start screen, HUD. |
| `apps/livefft/js/main.js` | Layout detection, HUD re-homing, theme-color meta, start buttons, tap-to-exit fullview. |
| `apps/livefft/js/ui.js` | Sheet open/close/drag, tabs, duplicate icon buttons, JS tooltips, demo picker. |
| `apps/livefft/js/state.js` | `settingsTab`. |
| `apps/livefft/js/views/*.js` | Use `plotLayout`; spectrogram pooling and catch-up clamp; spectrum hop gating and legend; scope envelope. |
| `apps/livefft/sw.js` | Cache bump and new files. |
| `README.md` | Multi-res wording. |
| `tests/plot.test.mjs` (new), `tests/hop.test.mjs` (new), `tests/spectrum.test.mjs` | Tests for the helpers and the averaging count. |

---

### Task 1: Theme tokens and control primitives

**Files:**
- Modify: `shared/css/theme.css`

- [ ] **Step 1: Replace the token blocks and control rules**

Replace the whole file with:

```css
/* Vibration Apps — shared instrument theme.
   Dark bench-instrument aesthetic: near-black blue ground, phosphor accent,
   hairline borders, condensed technical labels + mono readouts.
   Every colour used by the apps is a token here; app CSS and canvas code
   read tokens, never literals, so both themes stay complete. */

@import url('fonts.css');

:root {
  --bg-page: #0a0d14;
  --bg-panel: #0a0d14;        /* rail / header: same ground as the page */
  --bg-raised: #131a26;       /* controls */
  --bg-inset: #0a0d14;        /* plot: same ground as the page */
  --line: rgba(158, 178, 216, 0.14);
  --line-strong: rgba(158, 178, 216, 0.24);
  --text: #d9e2f4;
  --text-dim: #8a97b0;
  --text-faint: #5a657c;
  --accent: #38e1c8;          /* phosphor teal — live trace, primary actions */
  --accent-dim: rgba(56, 225, 200, 0.14);
  --accent-border: rgba(56, 225, 200, 0.45);
  --amber: #ffb454;           /* peak hold, warnings */
  --danger: #ff4d5e;
  --font-ui: 'Rajdhani', 'Avenir Next Condensed', sans-serif;
  --font-mono: 'JetBrains Mono', 'SF Mono', Menlo, monospace;
  --radius: 10px;
  --radius-sm: 6px;

  /* surfaces that float over the plot (phone pills, sheet, scrim) */
  --pill: rgba(16, 21, 31, 0.8);
  --sheet: #10151f;
  --sheet-shadow: 0 -12px 40px rgba(0, 0, 0, 0.5);
  --scrim: rgba(4, 6, 10, 0.45);
  --btn-hover: #182034;
  --thumb-glow: rgba(56, 225, 200, 0.5);
  --seg-shadow: rgba(0, 0, 0, 0.5);
  --toast-border: rgba(255, 77, 94, 0.5);
  --overlay-shadow: rgba(0, 0, 0, 0.5);

  /* plot colours, read by the canvas renderers via plotTheme() */
  --plot-grid: rgba(158, 178, 216, 0.08);
  --plot-grid-strong: rgba(158, 178, 216, 0.16);
  --plot-frame: rgba(158, 178, 216, 0.28);
  --plot-label: #8a97b0;
  --plot-title: #5a657c;
  --plot-text: #d9e2f4;
  --plot-crosshair: rgba(217, 226, 244, 0.25);
  --trace-main: #3fe8d2;
  --trace-ghost: rgba(63, 232, 210, 0.28);
  --trace-peak: #ffb454;
  --plot-tag-bg: rgba(13, 17, 25, 0.85);
  --plot-tag-border: rgba(158, 178, 216, 0.3);
  --plot-persist-color: rgba(63, 232, 210, 0.05);
  --plot-persist-comp: lighter;
  --plot-rubber: rgba(56, 225, 200, 0.08);
  --plot-rubber-line: rgba(56, 225, 200, 0.4);
}

:root[data-theme='light'] {
  --bg-page: #f4f6f9;
  --bg-panel: #ffffff;
  --bg-raised: #ffffff;
  --bg-inset: #f4f6f9;
  --line: rgba(28, 36, 51, 0.14);
  --line-strong: rgba(28, 36, 51, 0.26);
  --text: #1c2433;
  --text-dim: #5b6980;
  --text-faint: #8d99ad;
  --accent: #0c8f84;
  --accent-dim: rgba(12, 143, 132, 0.12);
  --accent-border: rgba(12, 143, 132, 0.5);
  --amber: #b45f06;
  --danger: #c0392b;

  --pill: rgba(255, 255, 255, 0.84);
  --sheet: #ffffff;
  --sheet-shadow: 0 -12px 40px rgba(28, 36, 51, 0.18);
  --scrim: rgba(28, 36, 51, 0.3);
  --btn-hover: #eef1f6;
  --thumb-glow: rgba(12, 143, 132, 0.35);
  --seg-shadow: rgba(28, 36, 51, 0.18);
  --toast-border: rgba(192, 57, 43, 0.5);
  --overlay-shadow: rgba(28, 36, 51, 0.25);

  --plot-grid: rgba(28, 36, 51, 0.07);
  --plot-grid-strong: rgba(28, 36, 51, 0.15);
  --plot-frame: rgba(28, 36, 51, 0.35);
  --plot-label: #5b6980;
  --plot-title: #8d99ad;
  --plot-text: #1c2433;
  --plot-crosshair: rgba(28, 36, 51, 0.35);
  --trace-main: #0c8f84;
  --trace-ghost: rgba(12, 143, 132, 0.35);
  --trace-peak: #b45f06;
  --plot-tag-bg: rgba(255, 255, 255, 0.92);
  --plot-tag-border: rgba(28, 36, 51, 0.25);
  --plot-persist-color: rgba(12, 143, 132, 0.05);
  --plot-persist-comp: source-over;
  --plot-rubber: rgba(12, 143, 132, 0.1);
  --plot-rubber-line: rgba(12, 143, 132, 0.45);
}

* { box-sizing: border-box; }

[hidden] { display: none !important; }

html, body {
  margin: 0;
  padding: 0;
  background: var(--bg-page);
  color: var(--text);
  font-family: var(--font-ui);
  font-size: 16px;
  -webkit-font-smoothing: antialiased;
  overscroll-behavior: none;
}

/* ---------- Panel primitives ---------- */

.panel {
  background: var(--bg-panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
}

.group {
  padding: 0.65rem 0.9rem 0.8rem;
}

.group + .group { border-top: 1px solid var(--line); }

.group-title {
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-faint);
  margin: 0 0 0.45rem;
  user-select: none;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
  min-height: 2rem;
}

.row + .row { margin-top: 0.35rem; }

.row > label {
  font-size: 0.86rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-dim);
  white-space: nowrap;
}

/* ---------- Controls ---------- */

select {
  appearance: none;
  -webkit-appearance: none;
  background: var(--bg-raised)
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='5'%3E%3Cpath d='M0 0l4 5 4-5z' fill='%238391ab'/%3E%3C/svg%3E")
    no-repeat right 0.55rem center;
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 0.78rem;
  padding: 0.32rem 1.5rem 0.32rem 0.55rem;
  max-width: 11rem;
  cursor: pointer;
  transition: border-color 0.15s;
}

select:hover, select:focus-visible { border-color: var(--line-strong); outline: none; }

.btn {
  font-family: var(--font-ui);
  font-size: 0.85rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text);
  background: var(--bg-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: 0.35rem 0.8rem;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
  user-select: none;
}

.btn:hover { border-color: var(--line-strong); background: var(--btn-hover); }
.btn:active { transform: translateY(1px); }
.btn:focus-visible { outline: 2px solid var(--accent-border); outline-offset: 1px; }

.btn.primary {
  background: var(--accent-dim);
  border-color: var(--accent-border);
  color: var(--accent);
}
.btn.primary:hover { filter: brightness(1.15); }

.btn.solid {
  background: var(--accent);
  border-color: var(--accent);
  color: #06110f;
}
.btn.solid:hover { filter: brightness(1.08); background: var(--accent); }

.btn.small { font-size: 0.72rem; padding: 0.22rem 0.55rem; }

/* borderless icon/text button: header actions, sheet title row */
.btn.ghost {
  background: transparent;
  border-color: transparent;
  color: var(--text-dim);
}
.btn.ghost:hover { background: var(--accent-dim); color: var(--accent); border-color: transparent; }

.btn.icon {
  width: 2.1rem;
  height: 2.1rem;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 1rem;
  font-weight: 500;
  letter-spacing: 0;
}

/* Segmented control: a radio group in a pill */
.seg {
  display: inline-flex;
  background: var(--bg-inset);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: 2px;
  gap: 2px;
}

.seg input { position: absolute; opacity: 0; pointer-events: none; }

.seg label {
  font-size: 0.78rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: var(--text-dim);
  padding: 0.22rem 0.6rem;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  white-space: nowrap;
  user-select: none;
}

.seg input:checked + label {
  background: var(--bg-raised);
  color: var(--accent);
  box-shadow: 0 0 0 1px var(--line-strong), 0 1px 4px var(--seg-shadow);
}

.seg input:focus-visible + label { outline: 2px solid var(--accent-border); outline-offset: 1px; }

/* Flat variant: no box, the active item is accent text with an underline */
.seg.flat { background: transparent; border-color: transparent; padding: 0; gap: 0; }
.seg.flat label { padding: 0.35rem 0.7rem; border-radius: 0; position: relative; }
.seg.flat input:checked + label { background: transparent; box-shadow: none; }
.seg.flat input:checked + label::after {
  content: '';
  position: absolute;
  left: 0.7rem;
  right: 0.7rem;
  bottom: 0;
  height: 2px;
  border-radius: 1px;
  background: var(--accent);
}

/* Toggle switch */
.switch {
  position: relative;
  width: 34px;
  height: 19px;
  flex: none;
  cursor: pointer;
}

.switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }

.switch .track {
  position: absolute;
  inset: 0;
  background: var(--bg-inset);
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  transition: background 0.18s, border-color 0.18s;
  pointer-events: none;
}

.switch .track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: calc(100% - 21px + 13px);
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--text-dim);
  transition: transform 0.18s, background 0.18s;
}

.switch input:checked ~ .track {
  background: var(--accent-dim);
  border-color: var(--accent);
}

.switch input:checked ~ .track::after {
  transform: translateX(15px);
  background: var(--accent);
}

/* Range slider */
input[type='range'] {
  appearance: none;
  -webkit-appearance: none;
  width: 100%;
  height: 18px;
  background: transparent;
  cursor: pointer;
}

input[type='range']::-webkit-slider-runnable-track {
  height: 3px;
  background: var(--line-strong);
  border-radius: 2px;
}

input[type='range']::-webkit-slider-thumb {
  appearance: none;
  -webkit-appearance: none;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--accent);
  margin-top: -5px;
  box-shadow: 0 0 6px var(--thumb-glow);
}

input[type='range']::-moz-range-track {
  height: 3px;
  background: var(--line-strong);
  border-radius: 2px;
}

input[type='range']::-moz-range-thumb {
  width: 13px;
  height: 13px;
  border: none;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 6px var(--thumb-glow);
}

input[type='number'], input[type='text'] {
  background: var(--bg-inset);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 0.78rem;
  padding: 0.3rem 0.45rem;
  width: 5.2rem;
}

input[type='number']:focus, input[type='text']:focus { border-color: var(--accent); outline: none; }

/* ---------- Readouts & lamps ---------- */

.readout {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--text-dim);
  white-space: nowrap;
}

.readout b {
  color: var(--text);
  font-weight: 500;
}

.readout .unit { color: var(--text-faint); }

.lamp {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: var(--text-faint);
  user-select: none;
}

.lamp::before {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--line-strong);
  transition: background 0.1s, box-shadow 0.1s;
}

.lamp.on { color: var(--danger); }
.lamp.on::before {
  background: var(--danger);
  box-shadow: 0 0 8px var(--danger);
}

.lamp.ok.on { color: var(--accent); }
.lamp.ok.on::before {
  background: var(--accent);
  box-shadow: 0 0 8px var(--accent);
}

/* ---------- Tooltips ---------- */
/* Add data-tip="..." to a control label. On hover devices a shared,
   fixed-position #tip element (positioned by JS, see livefft ui.js) shows
   the text, so the tip is never clipped by a scrolling panel. */

[data-tip] { cursor: help; }

.tip {
  position: fixed;
  z-index: 70;
  width: 14rem;
  max-width: 70vw;
  background: var(--bg-raised);
  border: 1px solid var(--line-strong);
  color: var(--text);
  font-family: var(--font-ui);
  font-size: 0.78rem;
  font-weight: 500;
  letter-spacing: 0.02em;
  line-height: 1.45;
  padding: 0.45rem 0.6rem;
  border-radius: var(--radius-sm);
  box-shadow: 0 8px 24px var(--overlay-shadow);
  pointer-events: none;
}

/* ---------- Touch sizes (phones and small tablets) ---------- */
/* 16 px on form controls stops iOS zooming on focus; 44 px targets. */

@media (max-width: 860px) {
  select, input[type='number'], input[type='text'] { font-size: 16px; }
  select { padding: 0.5rem 1.7rem 0.5rem 0.7rem; max-width: 13rem; }
  input[type='number'], input[type='text'] { padding: 0.45rem 0.55rem; width: 5.6rem; }
  .row { min-height: 44px; }
  .row + .row { margin-top: 0.15rem; }
  .row > label { font-size: 0.95rem; }
  .seg label { padding: 0.5rem 0.8rem; font-size: 0.9rem; }
  .btn { font-size: 0.9rem; padding: 0.55rem 1rem; }
  .btn.small { font-size: 0.8rem; padding: 0.4rem 0.7rem; }
  .btn.icon { width: 2.6rem; height: 2.6rem; font-size: 1.1rem; }
  .switch { width: 44px; height: 24px; }
  .switch .track::after { width: 18px; height: 18px; }
  .switch input:checked ~ .track::after { transform: translateX(20px); }
  input[type='range'] { height: 28px; }
  input[type='range']::-webkit-slider-thumb { width: 18px; height: 18px; margin-top: -7.5px; }
  input[type='range']::-moz-range-thumb { width: 18px; height: 18px; }
}

/* Subtle scrollbars */
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: var(--line-strong); border-radius: 4px; }
::-webkit-scrollbar-track { background: transparent; }
```

- [ ] **Step 2: Check nothing else references the removed tooltip pseudo-element**

Run: `grep -rn "data-tip\]" shared apps | grep -v theme.css`
Expected: no matches (the demos use `data-tip` attributes only, which still get `cursor: help`).

- [ ] **Step 3: Commit**

```bash
git add shared/css/theme.css
git commit -m "Theme: single ground per theme, floating-surface tokens, touch sizes, no colour literals"
```

---

### Task 2: `plotLayout()` and axis-label placement in `Axes.draw()`

**Files:**
- Modify: `shared/js/plot/axes.js`
- Test: `tests/plot.test.mjs` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/plot.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { plotLayout } from '../shared/js/plot/axes.js';

test('plotLayout: wide keeps outside labels with axis titles', () => {
  const L = plotLayout(1000, 600, {});
  assert.deepEqual(L.m, { l: 58, r: 14, t: 14, b: 40 });
  assert.equal(L.yInside, false);
  assert.equal(L.xTitle, true);
  assert.equal(L.yTitle, true);
  assert.deepEqual(L.rect, { x: 58, y: 14, w: 1000 - 58 - 14, h: 600 - 14 - 40 });
});

test('plotLayout: narrow landscape keeps the y axis outside, drops the x title', () => {
  const L = plotLayout(844, 390, { compact: true });
  assert.deepEqual(L.m, { l: 58, r: 12, t: 12, b: 26 });
  assert.equal(L.yInside, false);
  assert.equal(L.xTitle, false);
  assert.equal(L.yTitle, true);
});

test('plotLayout: narrow portrait puts the y labels inside', () => {
  const L = plotLayout(390, 700, { compact: true, yInside: true });
  assert.deepEqual(L.m, { l: 10, r: 10, t: 12, b: 26 });
  assert.equal(L.yInside, true);
  assert.equal(L.xTitle, false);
  assert.equal(L.yTitle, false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/plot.test.mjs`
Expected: FAIL — `plotLayout` is not exported.

- [ ] **Step 3: Implement**

In `shared/js/plot/axes.js`:

Add to `plotTheme()` (inside the `cachedTheme = {...}` object, after `persistComp`):

```js
    bg: v('--bg-inset', '#0a0d14'),
    rubber: v('--plot-rubber', 'rgba(56,225,200,0.08)'),
    rubberLine: v('--plot-rubber-line', 'rgba(56,225,200,0.4)'),
```

Add after `fmtVal`:

```js
/**
 * Plot margins for a canvas of w x h CSS px.
 * - wide (default): tick labels outside, axis titles on both axes
 * - compact (narrow viewport): no x title; the unit goes at the end of the
 *   tick row; y title kept (landscape)
 * - yInside (narrow portrait): y tick labels drawn inside the plot at the
 *   left edge with a halo; the y quantity becomes a top-left corner label
 * @returns {{m:{l,r,t,b}, rect:{x,y,w,h}, compact:boolean, yInside:boolean, xTitle:boolean, yTitle:boolean}}
 */
export function plotLayout(w, h, { compact = false, yInside = false } = {}) {
  const m = yInside
    ? { l: 10, r: 10, t: 12, b: 26 }
    : compact
      ? { l: 58, r: 12, t: 12, b: 26 }
      : { l: 58, r: 14, t: 14, b: 40 };
  return {
    m,
    rect: { x: m.l, y: m.t, w: w - m.l - m.r, h: h - m.t - m.b },
    compact,
    yInside,
    xTitle: !compact,
    yTitle: !yInside,
  };
}
```

Replace the `draw(ctx, opts = {})` method body's label section (everything from `// labels` to the end of the method) with:

```js
    // labels
    const yInside = !!opts.yInside;
    const xTitle = opts.xTitle !== false;
    const yTitle = opts.yTitle !== false && !yInside;
    ctx.fillStyle = t.label;
    ctx.font = t.font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const v of tx.major) {
      const px = this.xToPx(v);
      if (px >= rx - 2 && px <= rx + w + 2) ctx.fillText(xFmt(v), px, ry + h + 5);
    }
    if (yInside) {
      // inside the plot, above each grid line, with a halo in the plot ground
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = t.bg;
      for (const v of ty.major) {
        const py = this.yToPx(v);
        if (py < ry + 22 || py > ry + h - 4) continue; // keep clear of the corner label
        ctx.strokeText(yFmt(v), rx + 5, py - 7);
        ctx.fillText(yFmt(v), rx + 5, py - 7);
      }
    } else {
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (const v of ty.major) {
        const py = this.yToPx(v);
        if (py >= ry - 2 && py <= ry + h + 2) ctx.fillText(yFmt(v), rx - 7, py);
      }
    }

    // axis titles / units
    ctx.fillStyle = t.title;
    ctx.font = t.titleFont;
    if (opts.xLabel && xTitle) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(opts.xLabel.toUpperCase(), rx + w / 2, ry + h + 34);
    } else if (opts.xUnit) {
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(opts.xUnit, rx + w, ry + h + 5);
    }
    if (opts.yLabel && yTitle) {
      ctx.save();
      ctx.translate(rx - 44, ry + h / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(opts.yLabel.toUpperCase(), 0, 0);
      ctx.restore();
    } else if (opts.yLabel && yInside) {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.lineWidth = 3;
      ctx.strokeStyle = t.bg;
      ctx.strokeText(opts.yLabel.toUpperCase(), rx + 5, ry + 4);
      ctx.fillText(opts.yLabel.toUpperCase(), rx + 5, ry + 4);
    }
    ctx.restore();
  }
```

Also update the `draw` doc comment: `@param {object} opts { xLabel, yLabel, xFmt, yFmt, theme, yInside, xTitle, yTitle, xUnit }`.

Note the x tick label at the right edge would collide with `xUnit`; the views handle this by passing `xUnit` only in compact mode where the last tick is skipped by the `px <= rx + w + 2` guard when it sits exactly on the edge — acceptable overlap risk is avoided in the views by `xFmt` returning `''` for the max tick when `xUnit` is set. Implement that guard in the views (Tasks 6–8), not here.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: all pass, including the three new `plotLayout` tests.

- [ ] **Step 5: Commit**

```bash
git add shared/js/plot/axes.js tests/plot.test.mjs
git commit -m "Axes: plotLayout margin rule, inside y labels with halo, x unit instead of title in compact mode"
```

---

### Task 3: Spectrogram row pooling helper

**Files:**
- Create: `shared/js/plot/rows.js`
- Test: `tests/plot.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `tests/plot.test.mjs`:

```js
import { rowRanges, rowMax } from '../shared/js/plot/rows.js';
import { rfftMagSq } from '../shared/js/dsp/fft.js';
import { getWindow } from '../shared/js/dsp/windows.js';

test('rowRanges: rows wider than bins cover every bin between the row edges', () => {
  // rows top-first: 100, 50, 0 Hz; bins every 10 Hz; max bin index 10
  const { lo, hi } = rowRanges([100, 50, 0], (f) => f / 10, 10);
  assert.deepEqual([...lo], [8, 3, 0]);
  assert.deepEqual([...hi], [10, 7, 2]);
});

test('rowRanges: rows denser than bins fall back to the nearest bin', () => {
  const { lo, hi } = rowRanges([12, 11, 10], (f) => f / 10, 100);
  assert.deepEqual([...lo], [1, 1, 1]);
  assert.deepEqual([...hi], [1, 1, 1]);
});

test('rowMax pools narrow tones so no tone is lost at FFT 32768', () => {
  const fs = 48000;
  const N = 32768;
  const rows = 512;
  const fMin = 20;
  const fMax = 5000;
  const rowFreqs = new Float64Array(rows);
  for (let r = 0; r < rows; r++) rowFreqs[r] = fMin + (1 - r / (rows - 1)) * (fMax - fMin);
  const binHz = fs / N;
  const { lo, hi } = rowRanges(rowFreqs, (f) => f / binHz, N / 2);
  const { w, coherentGain } = getWindow('hann', N);
  const scale = 2 / (N * coherentGain);
  const x = new Float64Array(N);
  const P = new Float64Array(N / 2 + 1);
  let worstLoss = 0;
  for (let f = 100; f < 4900; f += 41.7) {
    for (let i = 0; i < N; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / fs) * w[i];
    rfftMagSq(x, P);
    let truePeak = 0;
    for (let b = 1; b <= N / 2; b++) truePeak = Math.max(truePeak, P[b]);
    let rowPeak = 0;
    for (let r = 0; r < rows; r++) rowPeak = Math.max(rowPeak, rowMax(P, lo, hi, r));
    const lossDb = 10 * Math.log10(truePeak / rowPeak);
    worstLoss = Math.max(worstLoss, lossDb);
    assert.ok(Math.abs(scale * Math.sqrt(rowPeak) - 0.5) < 0.1, `amplitude at ${f} Hz`);
  }
  assert.ok(worstLoss < 0.01, `worst pooled loss ${worstLoss} dB`);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/plot.test.mjs`
Expected: FAIL — cannot find module `rows.js`.

- [ ] **Step 3: Implement**

Create `shared/js/plot/rows.js`:

```js
// Display-row -> source-index ranges for heatmap rows.
//
// A spectrogram display has a fixed number of rows; the analysis has its
// own bins (FFT) or scales (CWT). When rows are coarser than bins, sampling
// one bin per row drops narrow tones that fall between the sampled bins.
// Each row therefore covers every source index between the half-way
// points to its neighbouring rows, and takes the maximum over that range.

/**
 * @param {ArrayLike<number>} rowFreqs centre frequency of each row (any order, monotonic)
 * @param {(f:number)=>number} freqToIndex fractional source index for a frequency (monotonic increasing)
 * @param {number} maxIndex highest valid source index
 * @returns {{lo: Int32Array, hi: Int32Array}} inclusive index range per row
 */
export function rowRanges(rowFreqs, freqToIndex, maxIndex) {
  const n = rowFreqs.length;
  const lo = new Int32Array(n);
  const hi = new Int32Array(n);
  const clamp = (i) => Math.max(0, Math.min(maxIndex, i));
  for (let r = 0; r < n; r++) {
    const f = rowFreqs[r];
    const ePrev = r > 0 ? 0.5 * (rowFreqs[r - 1] + f) : f;
    const eNext = r < n - 1 ? 0.5 * (f + rowFreqs[r + 1]) : f;
    const a = Math.min(ePrev, eNext);
    const b = Math.max(ePrev, eNext);
    let i0 = Math.ceil(freqToIndex(a) - 1e-9);
    let i1 = Math.floor(freqToIndex(b) + 1e-9);
    if (i1 < i0) i0 = i1 = Math.round(freqToIndex(f));
    lo[r] = clamp(i0);
    hi[r] = clamp(i1);
  }
  return { lo, hi };
}

/** Maximum of values[lo[r]..hi[r]] inclusive. */
export function rowMax(values, lo, hi, r) {
  let m = values[lo[r]];
  for (let i = lo[r] + 1; i <= hi[r]; i++) if (values[i] > m) m = values[i];
  return m;
}
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS (the pooling test takes a few seconds).

- [ ] **Step 5: Commit**

```bash
git add shared/js/plot/rows.js tests/plot.test.mjs
git commit -m "Plot: rowRanges/rowMax pool every bin a spectrogram row covers"
```

---

### Task 4: Sample-hopped frame gate

**Files:**
- Create: `shared/js/dsp/hop.js`
- Test: `tests/hop.test.mjs` (create)

- [ ] **Step 1: Write the failing tests**

Create `tests/hop.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameHopper } from '../shared/js/dsp/hop.js';

test('first call is due and sets the reference', () => {
  const h = new FrameHopper(2048);
  assert.equal(h.due(5000), true);
  assert.equal(h.due(5001), false);
});

test('one frame per hop of new samples, whatever the call cadence', () => {
  const fine = new FrameHopper(2048);
  let nFine = 0;
  for (let t = 0; t <= 100000; t += 300) if (fine.due(t)) nFine++;
  assert.equal(nFine, 1 + Math.floor(100000 / 2048));

  const coarse = new FrameHopper(2048);
  let nCoarse = 0;
  let lastDue = -Infinity;
  for (let t = 0; t <= 100000; t += 5000) {
    if (coarse.due(t)) {
      assert.ok(t - lastDue >= 2048, 'dues are at least one hop apart');
      lastDue = t;
      nCoarse++;
    }
  }
  assert.equal(nCoarse, 21);
});

test('a sample counter that goes backwards (source restart) resyncs', () => {
  const h = new FrameHopper(1024);
  h.due(50000);
  assert.equal(h.due(100), true);
  assert.equal(h.due(200), false);
  assert.equal(h.due(1200), true);
});

test('changing the hop keeps the reference', () => {
  const h = new FrameHopper(1024);
  h.due(0);
  h.setHop(4096);
  assert.equal(h.due(2000), false);
  assert.equal(h.due(4096), true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/hop.test.mjs`
Expected: FAIL — cannot find module `hop.js`.

- [ ] **Step 3: Implement**

Create `shared/js/dsp/hop.js`:

```js
// Gate analysis frames on the audio sample clock instead of the display
// refresh, so "N averages" means N frames with a fixed overlap whatever the
// frame rate (60 Hz, 120 Hz, or a throttled phone).

export class FrameHopper {
  /** @param {number} hop samples between processed frames (N/2 = 50% overlap) */
  constructor(hop) {
    this.hop = hop;
    this.last = null; // sample count at the last processed frame
  }

  setHop(hop) {
    this.hop = hop;
  }

  reset() {
    this.last = null;
  }

  /**
   * @param {number} total samples captured so far
   * @returns {boolean} true if a new frame should be processed now
   */
  due(total) {
    if (this.last === null || total < this.last) {
      this.last = total;
      return true;
    }
    const n = Math.floor((total - this.last) / this.hop);
    if (n < 1) return false;
    this.last += n * this.hop;
    return true;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/js/dsp/hop.js tests/hop.test.mjs
git commit -m "DSP: FrameHopper gates analysis frames on new samples"
```

---

### Task 5: Scope envelope helper

**Files:**
- Create: `shared/js/plot/envelope.js`
- Test: `tests/plot.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `tests/plot.test.mjs`:

```js
import { minMaxEnvelope } from '../shared/js/plot/envelope.js';

test('minMaxEnvelope: every column of a dense sine spans -A..+A', () => {
  const n = 48000;
  const buf = new Float32Array(n + 100);
  for (let i = 0; i < buf.length; i++) buf[i] = 0.7 * Math.sin((2 * Math.PI * 440 * i) / 48000);
  const cols = 200;
  const mn = new Float32Array(cols);
  const mx = new Float32Array(cols);
  minMaxEnvelope(buf, 100, n, cols, mn, mx);
  for (let c = 0; c < cols; c++) {
    assert.ok(mx[c] > 0.69, `col ${c} max ${mx[c]}`);
    assert.ok(mn[c] < -0.69, `col ${c} min ${mn[c]}`);
  }
});

test('minMaxEnvelope: with fewer samples than columns each column holds one sample', () => {
  const buf = Float32Array.from([1, 2, 3, 4]);
  const mn = new Float32Array(8);
  const mx = new Float32Array(8);
  minMaxEnvelope(buf, 0, 4, 8, mn, mx);
  assert.deepEqual([...mx], [1, 1, 2, 2, 3, 3, 4, 4]);
  assert.deepEqual([...mn], [1, 1, 2, 2, 3, 3, 4, 4]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/plot.test.mjs`
Expected: FAIL — cannot find module `envelope.js`.

- [ ] **Step 3: Implement**

Create `shared/js/plot/envelope.js`:

```js
// Min/max envelope of a sample run for drawing at pixel resolution. Taking
// every k-th sample aliases (a 440 Hz tone drawn at 120 samples/px looks
// like a 40 Hz wave); min/max per column keeps the true excursion.

/**
 * @param {Float32Array} buf samples
 * @param {number} start first sample index
 * @param {number} n number of samples to cover
 * @param {number} cols number of output columns (pixels)
 * @param {Float32Array} outMin length >= cols
 * @param {Float32Array} outMax length >= cols
 */
export function minMaxEnvelope(buf, start, n, cols, outMin, outMax) {
  for (let c = 0; c < cols; c++) {
    let i0 = start + Math.floor((c * n) / cols);
    let i1 = start + Math.floor(((c + 1) * n) / cols);
    if (i1 <= i0) i1 = i0 + 1;
    let mn = buf[i0];
    let mx = buf[i0];
    for (let i = i0 + 1; i < i1; i++) {
      const v = buf[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    outMin[c] = mn;
    outMax[c] = mx;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/js/plot/envelope.js tests/plot.test.mjs
git commit -m "Plot: minMaxEnvelope for scope traces"
```

---

### Task 6: Worklet passthrough, colormap ground, comments, README

**Files:**
- Modify: `shared/js/audio/capture-worklet.js`
- Modify: `shared/js/plot/colormap.js`
- Modify: `shared/js/dsp/windows.js:8-13`, `shared/js/dsp/multires.js:1-14`
- Modify: `README.md` (Design notes)

- [ ] **Step 1: Worklet copies input to output**

In `capture-worklet.js` change the `process` signature and body start to:

```js
  process(inputs, outputs) {
    const input = inputs[0];
    // pass the signal through so the monitor gain (demo "Listen") has audio
    if (input && input.length > 0 && outputs[0] && outputs[0].length > 0) {
      outputs[0][0].set(input[0]);
    }
    if (input && input.length > 0) {
```

(the rest of the method is unchanged).

- [ ] **Step 2: Colormap blends into a given ground**

In `colormap.js`, change the signature and the blend:

```js
/**
 * @param {string} name viridis | inferno | magma | plasma
 * @param {boolean} reversed true for the light-background variant
 *   (low = light, high = dark) used when the UI is in light mode
 * @param {number[]} ground [r,g,b] 0..255 the reversed variant fades into
 *   (the page ground), default white
 * @returns {Uint8Array} 256*3 RGB entries
 */
export function getColormap(name, reversed = false, ground = [255, 255, 255]) {
  const key = reversed ? `${name}_r_${ground.join(',')}` : name;
```

and in the inner loop replace `v = v * whiteBlend + (1 - whiteBlend);` with

```js
      v = v * whiteBlend + (1 - whiteBlend) * (ground[ch] / 255);
```

and update the comment above it to `// light variant: silence is the page ground, blending into the (reversed) map over the first ~12%`.

- [ ] **Step 3: Comment corrections**

`windows.js`: replace `// SFT3F flat-top (ISO 18431-2 style): near-zero amplitude error at peaks` with `// Flat-top (MATLAB flattopwin coefficients, ENBW ≈ 3.77 bins): near-zero amplitude error at peaks`.

`multires.js` header: replace lines 7–10 (`// Stage sizes are N, 4N, 16N ... at 1/4 the frequency.`) with:

```js
// Stage sizes are N, 4N, 16N samples at the full sample rate. Stage k
// covers frequencies up to (fs/2)/4^k, so every region spans the same
// range of relative resolution: df/f = 2/N at the top of a region and 8/N
// at its bottom. At each boundary the resolution jumps by 4x (the dashed
// lines in the display); the echo lines carry each stage past its boundary
// so the eye can follow the level across the jump.
```

- [ ] **Step 4: README wording**

In `README.md` replace `boundaries at fs/8 and fs/32; the` ... `Δf/f matches across each boundary.` Actually the sentence is: `the spectrum's multi-res mode stitches 3 FFT lengths (N, 4N, 16N) with boundaries at fs/8 and fs/32;` — extend it to read:

```
- **Multi-resolution**: the spectrum's multi-res mode stitches 3 FFT
  lengths (N, 4N, 16N) with boundaries at fs/8 and fs/32, so every region
  spans the same range of relative resolution (Δf/f from 2/N to 8/N) and
  the resolution jumps by 4× at each boundary; the spectrogram's wavelet
  mode is a Morlet CWT computed in a Web Worker.
```

- [ ] **Step 5: Run tests and commit**

Run: `npm test` — expected PASS.

```bash
git add shared/js/audio/capture-worklet.js shared/js/plot/colormap.js shared/js/dsp/windows.js shared/js/dsp/multires.js README.md
git commit -m "Worklet passes audio through (Listen works); colormap fades to the page ground; multi-res and flat-top wording"
```

---

### Task 7: Interaction `onTap`

**Files:**
- Modify: `shared/js/plot/interaction.js`

- [ ] **Step 1: Add the callback**

In the constructor doc comment add `*   onTap(px, py)       — pointer released without dragging or pinching`.

In `#down`, after `this.pointers.set(e.pointerId, p);` add `this.tapCandidate = this.pointers.size === 1;`. In the pinch branch (`if (this.pointers.size === 2) {`) add `this.tapCandidate = false;` as its first line.

Replace `#up` with:

```js
  #up(e) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    let tapped = this.tapCandidate && this.pointers.size === 0;
    this.tapCandidate = false;
    if (this.drag) {
      const { x0, x1, moved } = this.drag;
      this.drag = null;
      if (moved && Math.abs(x1 - x0) > 12) {
        tapped = false;
        const min = this.axes.pxToX(Math.min(x0, x1));
        const max = this.axes.pxToX(Math.max(x0, x1));
        this.cb.onXRange?.(min, max);
      } else if (moved) {
        tapped = false;
      }
    }
    if (tapped) {
      const p = this.#pos(e);
      this.cb.onTap?.(p.x, p.y);
    }
  }
```

- [ ] **Step 2: Commit**

```bash
git add shared/js/plot/interaction.js
git commit -m "Plot interaction: onTap callback"
```

---

### Task 8: Spectrogram view — row pooling, catch-up clamp, layout

**Files:**
- Modify: `apps/livefft/js/views/spectrogram.js`

- [ ] **Step 1: Imports**

Replace the import block's plot lines with:

```js
import { getColormap } from '../../../../shared/js/plot/colormap.js';
import { Axes, fmtHz, plotTheme, plotLayout } from '../../../../shared/js/plot/axes.js';
import { rowRanges, rowMax } from '../../../../shared/js/plot/rows.js';
import { effectiveFreqScale } from '../state.js';
```

- [ ] **Step 2: Row ranges instead of a row map**

In the constructor replace `this.rowMap = null;     // row -> source bin/scale index` with `this.rowLo = null;      // per row: inclusive source bin/scale range\n    this.rowHi = null;`.

Add a helper method after `#rowFreq`:

```js
  /** Row centre frequencies, top row first. */
  #rowFreqs(fr) {
    const out = new Float64Array(ROWS);
    for (let r = 0; r < ROWS; r++) out[r] = this.#rowFreq(r, fr);
    return out;
  }
```

Replace `#buildCwtRowMap()` with:

```js
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
```

In `#rebuild()` replace `this.rowMap = new Float32Array(ROWS);` with nothing (delete the line), and replace the STFT row-map loop

```js
      const binHz = fs / n;
      for (let r = 0; r < ROWS; r++) {
        this.rowMap[r] = Math.min(Math.round(this.#rowFreq(r, fr) / binHz), n / 2);
      }
```

with

```js
      const binHz = fs / n;
      const { lo, hi } = rowRanges(this.#rowFreqs(fr), (f) => f / binHz, n / 2);
      this.rowLo = lo;
      this.rowHi = hi;
```

In `#writeCwtColumns` replace the inner row loop with:

```js
      for (let r = 0; r < ROWS; r++) {
        let amp = 0;
        for (let j = this.rowLo[r]; j <= this.rowHi[r]; j++) {
          const a = data[j * nCols + c];
          if (a > amp) amp = a;
        }
        this.dbCol[r] = 20 * Math.log10(Math.max(amp, 1e-12));
      }
```

In `tick()` (STFT branch) replace the row loop

```js
      for (let r = 0; r < ROWS; r++) {
        const b = this.rowMap[r];
        const edge = b === 0 || b === nBins - 1;
        let amp = this.ampScale * Math.sqrt(Math.max(this.power[b], 0));
        if (edge) amp /= 2;
        this.dbCol[r] = 20 * Math.log10(Math.max(amp, 1e-12));
      }
```

with

```js
      for (let r = 0; r < ROWS; r++) {
        const p = rowMax(this.power, this.rowLo, this.rowHi, r);
        const edge = this.rowLo[r] === 0 || this.rowHi[r] === nBins - 1;
        let amp = this.ampScale * Math.sqrt(Math.max(p, 0));
        if (edge && this.rowLo[r] === this.rowHi[r]) amp /= 2;
        this.dbCol[r] = 20 * Math.log10(Math.max(amp, 1e-12));
      }
```

- [ ] **Step 3: Catch-up clamp**

In `tick()` replace

```js
      let toEmit = Math.floor(this.sinceCol / this.colPeriodSamples);
      if (toEmit <= 0) return;
      this.sinceCol -= toEmit * this.colPeriodSamples;
      this.newestColTotal = total - this.sinceCol;
      // catch-up bound: after a stall the current spectrum is duplicated
      // rather than dropping display time entirely
      toEmit = Math.min(toEmit, 64);
```

with

```js
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
```

- [ ] **Step 4: Layout in render**

Change the signature to `render(ctx, w, h, hover, _rubber, layout = {})` and replace

```js
    const m = { l: 64, r: 14, t: 14, b: 46 };
    this.axes.setRect(m.l, m.t, w - m.l - m.r, h - m.t - m.b);
```

with

```js
    const L = plotLayout(w, h, layout);
    this.axes.setRect(L.rect.x, L.rect.y, L.rect.w, L.rect.h);
```

Replace the `this.axes.draw(ctx, {...})` call with:

```js
    this.axes.draw(ctx, {
      xLabel: 'time · s',
      yLabel: L.yInside ? 'frequency · Hz' : 'frequency · Hz',
      xFmt: (v) => (L.compact && Math.abs(v) < 1e-6 ? '' : Math.abs(v % 1) < 1e-6 ? v.toFixed(0) : v.toFixed(1)),
      xUnit: L.compact ? '0 s' : '',
      yFmt: fmtHz,
      yInside: L.yInside,
      xTitle: L.xTitle,
      yTitle: L.yTitle,
      theme: { grid: 'transparent', gridStrong: 'transparent' },
    });
```

Replace the colour-scale note lines

```js
    const range = `${s.get('sgFloorDb')}…${s.get('sgCeilDb')} dBFS`;
```

with

```js
    const range = `${s.get('sgFloorDb')}…${s.get('sgCeilDb')} dBFS amplitude`;
```

- [ ] **Step 5: Run tests, commit**

Run: `npm test` — PASS (no view tests; this guards the shared helpers).

```bash
git add apps/livefft/js/views/spectrogram.js
git commit -m "Spectrogram: pool every bin per row, true time axis after a stall, shared layout"
```

---

### Task 9: Spectrum view — hop gating, layout, legend, rubber tokens

**Files:**
- Modify: `apps/livefft/js/views/spectrum.js`

- [ ] **Step 1: Imports and hopper**

Replace the axes import with `import { Axes, fmtHz, plotTheme, plotLayout } from '../../../../shared/js/plot/axes.js';` and add `import { FrameHopper } from '../../../../shared/js/dsp/hop.js';`.

In the constructor after `this.dominantPeak = null;` add:

```js
    this.hopper = new FrameHopper(2048); // frames advance on samples, not display refresh
    this.lastProcAt = 0;
```

- [ ] **Step 2: Gate `tick` on samples**

Replace `tick(engine, dt)` with:

```js
  /** Pull newest samples and update the processors, once per hop of new
   *  samples (50% overlap) so averaging counts data frames. */
  tick(engine, _dt) {
    const multires = this.state.get('resMode') === 'multires';
    const need = multires ? this.multi.maxSize : this.proc.fftSize;
    const base = multires ? this.multi.baseSize : this.proc.fftSize;
    this.hopper.setHop(base >> 1);
    if (!this.hopper.due(engine.totalSamples)) return;
    const now = performance.now();
    const dt = this.lastProcAt ? Math.min((now - this.lastProcAt) / 1000, 0.5) : 0;
    this.lastProcAt = now;
    if (need > this.scratch.length) this.scratch = new Float32Array(need);
    const view = this.scratch.subarray(0, need);
    if (!engine.read(need, view)) return;
    if (multires) {
      this.multi.process(view, dt);
    } else {
      this.proc.process(view, dt);
    }
  }
```

In `#configure()` add `this.hopper?.reset();` after `this.clearPersistence();` (the hopper is created after the first `#configure` call, hence the optional chaining).

- [ ] **Step 3: Layout and labels in `render`**

Change the signature to `render(ctx, w, h, hover, rubberBand, layout = {})`. Replace

```js
    const m = { l: 64, r: 14, t: 14, b: 46 };
    this.axes.setRect(m.l, m.t, w - m.l - m.r, h - m.t - m.b);
```

with

```js
    const L = plotLayout(w, h, layout);
    this.axes.setRect(L.rect.x, L.rect.y, L.rect.w, L.rect.h);
```

Replace the `this.axes.draw(ctx, {...})` call with:

```js
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
```

(and delete the earlier `const qLabel = ...` line so it is declared once).

Replace the rubber band colours

```js
      ctx.fillStyle = 'rgba(56, 225, 200, 0.08)';
      ctx.strokeStyle = 'rgba(56, 225, 200, 0.4)';
```

with

```js
      ctx.fillStyle = th.rubber;
      ctx.strokeStyle = th.rubberLine;
```

Change the legend call to pass the layout: `if (legend.length > 1 || s.get('peakHold')) this.#drawLegend(ctx, legend, th, L.yInside);` and in `#drawLegend(ctx, entries, th, bottom = false)` replace `const y = r.y + 12;` with `const y = bottom ? r.y + r.h - 10 : r.y + 12;`.

- [ ] **Step 4: Commit**

```bash
git add apps/livefft/js/views/spectrum.js
git commit -m "Spectrum: average on sample hops, shared layout, legend placement, themed rubber band"
```

---

### Task 10: Scope view — envelope and layout

**Files:**
- Modify: `apps/livefft/js/views/scope.js`

- [ ] **Step 1: Rewrite**

Replace the file with:

```js
// Scope view: time-domain trace with optional rising-edge trigger for a
// stable display, plus RMS / peak level readouts.

import { Axes, plotTheme, plotLayout } from '../../../../shared/js/plot/axes.js';
import { minMaxEnvelope } from '../../../../shared/js/plot/envelope.js';

export class ScopeView {
  constructor(state) {
    this.state = state;
    this.axes = new Axes();
    this.sampleRate = 48000;
    this.buf = new Float32Array(1);
    this.envMin = new Float32Array(1);
    this.envMax = new Float32Array(1);
    this.rms = 0;
    this.peak = 0;
    this.lastTick = 0;
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
      // smooth the readouts a little, on wall-clock time so the decay does
      // not depend on the frame rate
      const now = performance.now();
      const dt = this.lastTick ? Math.min((now - this.lastTick) / 1000, 0.2) : 0.016;
      this.lastTick = now;
      const rmsNow = Math.sqrt(sumSq / n);
      this.rms += (1 - Math.exp(-dt / 0.05)) * (rmsNow - this.rms);
      this.peak = Math.max(peak, this.peak * Math.exp(-dt / 0.25));
    }
  }

  /** Find the start index for a stable display window. */
  #triggerIndex(n) {
    if (!this.state.get('scopeTrigger')) return n;
    const buf = this.buf;
    const thresh = Math.max(this.peak * 0.1, 0.005);
    // search backward from centre for a rising crossing of 0 with hysteresis
    for (let i = n; i > 1; i--) {
      if (buf[i - 1] < -thresh * 0.2 && buf[i] >= 0 && buf[i] - buf[i - 1] > 0) {
        return i;
      }
    }
    return n;
  }

  render(ctx, w, h, hover, _rubber, layout = {}) {
    const th = plotTheme();
    const span = this.state.get('scopeSpan');
    const n = Math.floor(span * this.sampleRate);
    const useMs = span < 1;
    const xMax = useMs ? span * 1000 : span;
    const L = plotLayout(w, h, layout);
    this.axes.setRect(L.rect.x, L.rect.y, L.rect.w, L.rect.h);
    this.axes.setX(0, xMax, false);

    // y auto: generous headroom, min +-0.01
    const yr = Math.max(this.peak * 1.3, 0.01);
    this.axes.setY(-yr, yr, false);

    ctx.clearRect(0, 0, w, h);
    const xFmtFull = (v) => (span < 0.02 || !useMs ? +v.toFixed(1) + '' : v.toFixed(0));
    this.axes.draw(ctx, {
      xLabel: useMs ? 'time · ms' : 'time · s',
      yLabel: 'signal · full scale',
      xFmt: L.compact ? (v) => (v >= xMax - 1e-9 ? '' : xFmtFull(v)) : xFmtFull,
      xUnit: L.compact ? (useMs ? 'ms' : 's') : '',
      yFmt: (v) => (yr < 0.1 ? v.toFixed(3) : v.toFixed(2)),
      yInside: L.yInside,
      xTitle: L.xTitle,
      yTitle: L.yTitle,
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

    ctx.strokeStyle = th.traceMain;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const cols = Math.max(1, Math.round(r.w));
    if (n > 2 * cols) {
      // dense: min/max envelope per pixel column
      if (this.envMin.length < cols) {
        this.envMin = new Float32Array(cols);
        this.envMax = new Float32Array(cols);
      }
      minMaxEnvelope(this.buf, start, n, cols, this.envMin, this.envMax);
      for (let c = 0; c < cols; c++) {
        const px = r.x + c + 0.5;
        const y1 = this.axes.yToPx(this.envMax[c]);
        const y2 = this.axes.yToPx(this.envMin[c]);
        if (c === 0) ctx.moveTo(px, y1); else ctx.lineTo(px, y1);
        ctx.lineTo(px, y2);
      }
    } else {
      for (let i = 0; i < n; i++) {
        const px = r.x + (i / n) * r.w;
        const py = this.axes.yToPx(this.buf[start + i]);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
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
    ctx.fillText(`rms ${rmsDb.toFixed(1)} dBFS   peak ${peakDb.toFixed(1)} dBFS`, r.x + r.w - 6, r.y + (L.yInside ? 22 : 6));

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
```

- [ ] **Step 2: Commit**

```bash
git add apps/livefft/js/views/scope.js
git commit -m "Scope: min/max envelope per pixel, wall-clock readout smoothing, shared layout"
```

---

### Task 11: Markup — header, HUD, sheet, start screen

**Files:**
- Modify: `apps/livefft/index.html`

- [ ] **Step 1: Head**

Replace `<meta name="theme-color" content="#07090f">` with:

```html
  <meta name="theme-color" content="#0a0d14">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
```

- [ ] **Step 2: Header**

Replace the `<header id="topbar">…</header>` block with:

```html
    <header id="topbar">
      <div id="brand">
        <span id="brand-name">LIVE FFT</span>
        <span id="brand-sub">vibration apps</span>
      </div>

      <nav class="seg flat" id="view-tabs" aria-label="View">
        <input type="radio" name="view" value="spectrum" id="view-spectrum">
        <label for="view-spectrum">Spectrum</label>
        <input type="radio" name="view" value="spectrogram" id="view-spectrogram">
        <label for="view-spectrogram">Spectrogram</label>
        <input type="radio" name="view" value="scope" id="view-scope">
        <label for="view-scope">Scope</label>
      </nav>

      <div id="topbar-right">
        <span class="lamp" id="lamp-clip">CLIP</span>
        <button class="btn ghost icon" id="btn-help" aria-label="Explain the current settings" title="What do these settings mean?">?</button>
        <button class="btn ghost icon" id="btn-full" aria-label="Full screen" title="Full screen — hide all controls">⤢</button>
        <button class="btn ghost icon" id="btn-theme" aria-label="Toggle light/dark theme" title="Light / dark theme">☀</button>
        <button class="btn primary" id="btn-run" title="Space bar toggles run/pause">▶ Start</button>
        <button class="btn ghost icon" id="btn-panel" aria-label="Settings" title="Settings">☰</button>
      </div>
    </header>
```

- [ ] **Step 3: Stage**

Replace the `<main id="stage">…</main>` block with:

```html
    <main id="stage">
      <div id="plot-wrap" class="idle">
        <canvas id="plot"></canvas>
        <div id="overlay-msg">
          <div id="overlay-card">
            <h2>Live FFT</h2>
            <p>Spectrum, spectrogram and scope from the microphone, in dBFS.</p>
            <div id="overlay-btns">
              <button class="btn solid" id="btn-start-mic">▶ Start · microphone</button>
              <select id="sel-demo" class="btn ghost" aria-label="Try a demo signal">
                <option value="" selected disabled>Try a demo signal ▾</option>
              </select>
            </div>
          </div>
        </div>
      </div>
      <div id="hud">
        <span class="readout">fs <b id="ro-fs">—</b><span class="unit"> Hz</span></span>
        <span class="readout">Δf <b id="ro-res">—</b></span>
        <span class="readout" id="ro-avg-wrap" hidden>avg <b id="ro-avg">0</b></span>
        <span class="readout" id="ro-peak-wrap">peak <b id="ro-peak">—</b></span>
      </div>
      <button id="btn-settings" aria-label="Settings">⚙ Settings</button>
    </main>

    <div id="scrim" hidden></div>
```

- [ ] **Step 4: Panel head and group tabs**

Replace `<aside id="panel" class="panel">` with:

```html
    <aside id="panel" class="panel" aria-label="Settings">
      <div id="panel-head">
        <span id="panel-handle" aria-hidden="true"></span>
        <div id="panel-title">
          <h4>Settings</h4>
          <button class="btn ghost icon" id="btn-help2" aria-label="Explain the current settings">?</button>
          <button class="btn ghost icon" id="btn-full2" aria-label="Full screen">⤢</button>
          <button class="btn ghost icon" id="btn-theme2" aria-label="Toggle light/dark theme">☀</button>
          <button class="btn ghost icon" id="btn-panel-close" aria-label="Close settings">✕</button>
        </div>
        <nav id="panel-tabs" aria-label="Settings groups"></nav>
      </div>
      <div id="panel-body">
```

and add `</div>` (closing `#panel-body`) immediately before `</aside>`.

Add `data-tab` attributes to the groups: `#grp-source` → `data-tab="Source"`; `#grp-analysis` → `data-tab="Analysis"`; the Averaging group → `data-tab="Analysis"`; the Display group → `data-tab="Display"`; Frequency axis → `data-tab="Axes"`; Amplitude axis → `data-tab="Axes"`; `#grp-spectrogram` → `data-tab="Spectrogram"`; Scope → `data-tab="Scope"`; the fine-print group → `data-tab="Source"`.

- [ ] **Step 5: Tooltip text updates**

Resolution label `data-tip`: replace with `"Fixed: one FFT length everywhere. Multi-res: three stitched lengths — N, 4N, 16N from the FFT size (N capped at 8192) — with regions split at fs/8 and fs/32. Every region spans the same range of relative resolution (Δf/f from 2/N at its top to 8/N at its bottom) and the resolution jumps by 4× at each dashed boundary. Low frequencies get up to 16× finer bins at the cost of slower response there."`

Peak hold `data-tip`: `"Keeps the maximum of the displayed trace since the last reset — shown as the second (amber) trace. With averaging on it holds the averaged level; switch averaging off to catch short transients."`

CWT f min / max `data-tip`: `"Frequency range the wavelet analysis covers. Lower f min needs longer wavelets, so the display lags a little more; phones lag noticeably below about 20 Hz."`

Floor / Ceiling `data-tip`s: prefix with `Amplitude level (dBFS) mapped to ...` in place of `Level (dBFS) mapped to ...`.

- [ ] **Step 6: Tooltip host**

Before `<div id="toast" hidden></div>` add `<div id="tip" class="tip" hidden></div>`.

- [ ] **Step 7: Commit**

```bash
git add apps/livefft/index.html
git commit -m "Live FFT markup: ghost header actions, HUD, settings sheet head and tabs, start screen buttons"
```

---

### Task 12: Layout CSS

**Files:**
- Modify: `apps/livefft/css/app.css`

- [ ] **Step 1: Replace the file**

```css
/* Live FFT app layout.
   Wide (> 860 px): header row, plot stage, settings rail on the right.
   Narrow: the plot is the screen; header actions float over it as pills
   and the settings rail becomes a bottom sheet. Only the canvas frame
   boxes anything. */

html, body { height: 100%; overflow: hidden; }

#app {
  display: grid;
  grid-template-areas:
    'topbar topbar'
    'stage panel';
  grid-template-rows: 48px 1fr;
  grid-template-columns: 1fr 272px;
  height: 100dvh;
}

/* ---------- Header ---------- */

#topbar {
  grid-area: topbar;
  display: flex;
  align-items: center;
  gap: 1.2rem;
  padding: 0 0.6rem 0 1.1rem;
  background: var(--bg-panel);
}

#brand {
  display: flex;
  flex-direction: column;
  line-height: 1;
  user-select: none;
}

#brand-name {
  font-size: 1.15rem;
  font-weight: 700;
  letter-spacing: 0.16em;
  color: var(--text);
}

#brand-name::after {
  content: '';
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-left: 8px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 8px var(--accent);
  opacity: 0.25;
  transition: opacity 0.3s;
}

body.running #brand-name::after {
  opacity: 1;
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  50% { opacity: 0.45; }
}

@media (prefers-reduced-motion: reduce) {
  body.running #brand-name::after { animation: none; }
}

#brand-sub {
  font-size: 0.6rem;
  font-weight: 600;
  letter-spacing: 0.34em;
  text-transform: uppercase;
  color: var(--text-faint);
  margin-top: 3px;
}

#topbar-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 0.15rem;
}

#lamp-clip { margin-right: 0.6rem; }
#btn-run { min-width: 6.2rem; margin-left: 0.6rem; }
#btn-panel { display: none; }

/* ---------- Stage ---------- */

#stage {
  grid-area: stage;
  position: relative;
  min-width: 0;
  min-height: 0;
}

#plot-wrap {
  position: absolute;
  inset: 0;
  background: var(--bg-inset);
  overflow: hidden;
}

#plot {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  cursor: crosshair;
}

/* start state: the grid is drawn dimmed behind the empty-state stack */
#plot-wrap.idle #plot { opacity: 0.55; }

/* readouts in the plot's top-right corner */
#hud {
  position: absolute;
  top: 10px;
  right: 16px;
  display: flex;
  align-items: center;
  gap: 1rem;
  pointer-events: none;
  white-space: nowrap;
}

#hud .readout { font-size: 0.74rem; }
#ro-peak { color: var(--accent); font-size: 0.86rem; }

#btn-settings { display: none; }

/* ---------- Start screen ---------- */

#overlay-msg {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
}

#overlay-card {
  display: grid;
  gap: 0.6rem;
  justify-items: center;
  text-align: center;
  width: min(100%, 18rem);
  animation: fade-in 0.6s ease-out;
}

@keyframes fade-in {
  from { opacity: 0; transform: translateY(8px); }
}

#overlay-card h2 {
  font-size: 1.4rem;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  margin: 0;
  color: var(--text);
}

#overlay-card p {
  margin: 0;
  font-size: 0.95rem;
  line-height: 1.35;
  color: var(--text-dim);
}

#overlay-btns {
  display: grid;
  gap: 0.5rem;
  width: 100%;
  margin-top: 0.5rem;
}

#overlay-btns .btn { height: 2.75rem; font-size: 0.88rem; }

#sel-demo {
  appearance: none;
  -webkit-appearance: none;
  background-image: none;
  text-align: center;
  text-align-last: center;
  font-family: var(--font-ui);
  font-size: 0.88rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-dim);
  border: 1px solid var(--line);
  max-width: none;
  padding: 0 1rem;
}

/* ---------- Rail (wide) ---------- */

#panel {
  grid-area: panel;
  background: var(--bg-page);
  border: none;
  border-left: 1px solid var(--line);
  border-radius: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

#panel-head { display: none; }

#panel-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scrollbar-gutter: stable;
  padding: 0.6rem 0.4rem 0.6rem 0;
  display: flex;
  flex-direction: column;
}

#panel .group { flex: none; border: none; padding: 0.55rem 0.9rem 0.7rem 1.1rem; }
#panel .group + .group { margin-top: 0.35rem; }

/* In the spectrogram view the method + its settings come first, so
   toggling STFT/Wavelet never moves the shared controls below them. */
#grp-source { order: -2; }
body[data-view='spectrogram'] #grp-spectrogram { order: -1; }

.fine-print {
  font-size: 0.72rem;
  line-height: 1.5;
  color: var(--text-faint);
  margin: 0;
}

.fine-print a { color: var(--text-dim); }

#scrim {
  position: fixed;
  inset: 0;
  background: var(--scrim);
  z-index: 19;
}

/* ---------- Full-screen view ---------- */

body.fullview #topbar,
body.fullview #panel,
body.fullview #btn-settings { display: none; }

body.fullview #app {
  grid-template-areas: 'stage';
  grid-template-rows: 1fr;
  grid-template-columns: 1fr;
}

#btn-exit-full {
  position: fixed;
  top: calc(0.7rem + env(safe-area-inset-top));
  right: calc(0.7rem + env(safe-area-inset-right));
  z-index: 60;
  background: var(--bg-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  font-size: 0.9rem;
  padding: 0.3rem 0.6rem;
  cursor: pointer;
  opacity: 0.45;
  transition: opacity 0.2s;
}

#btn-exit-full:hover { opacity: 1; }

/* ---------- Help overlay ---------- */

#help-overlay {
  position: fixed;
  inset: 0;
  background: var(--scrim);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}

#help-card {
  width: min(34rem, 100%);
  max-height: min(82dvh, 44rem);
  display: flex;
  flex-direction: column;
  box-shadow: 0 24px 80px var(--overlay-shadow);
  animation: fade-in 0.2s ease-out;
}

#help-card header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--line);
}

#help-card h3 {
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

#help-body {
  overflow-y: auto;
  padding: 0.2rem 1.1rem 1.2rem;
  overscroll-behavior: contain;
}

#help-body h4 {
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-faint);
  margin: 1.1rem 0 0.2rem;
}

#help-body dl { margin: 0; }

#help-body dt {
  font-weight: 600;
  color: var(--accent);
  font-size: 0.92rem;
  letter-spacing: 0.03em;
  margin-top: 0.6rem;
}

#help-body dd {
  margin: 0.1rem 0 0;
  font-size: 0.85rem;
  line-height: 1.5;
  color: var(--text-dim);
}

@media (max-width: 640px) {
  #help-overlay { padding: 0; }
  #help-card { width: 100%; height: 100%; max-height: none; border-radius: 0; border: none; }
}

/* ---------- Toast ---------- */

#toast {
  position: fixed;
  left: 50%;
  bottom: calc(1.4rem + env(safe-area-inset-bottom));
  transform: translateX(-50%);
  background: var(--bg-raised);
  border: 1px solid var(--toast-border);
  color: var(--text);
  font-size: 0.85rem;
  padding: 0.55rem 1rem;
  border-radius: var(--radius-sm);
  box-shadow: 0 6px 24px var(--overlay-shadow);
  z-index: 30;
  max-width: min(90vw, 30rem);
}

/* =====================================================================
   Narrow screens: the plot is the screen, chrome floats over it
   ===================================================================== */

@media (max-width: 860px) {
  #app { display: block; height: 100dvh; position: relative; }

  #stage {
    position: absolute;
    inset: 0;
    padding: 0 env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
  }

  #plot-wrap { position: relative; width: 100%; height: 100%; }

  /* header becomes a transparent row of pills over the plot */
  #topbar {
    position: absolute;
    z-index: 5;
    top: calc(10px + env(safe-area-inset-top));
    left: calc(12px + env(safe-area-inset-left));
    right: calc(12px + env(safe-area-inset-right));
    padding: 0;
    gap: 8px;
    background: transparent;
    pointer-events: none;
  }

  #topbar > * { pointer-events: auto; }
  #brand { display: none; }
  #lamp-clip { display: none; }
  #btn-help, #btn-full, #btn-theme { display: none; }

  .pill,
  #view-tabs,
  #hud,
  #btn-settings,
  #btn-panel {
    background: var(--pill);
    border: 1px solid var(--line);
    border-radius: 20px;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
  }

  #view-tabs { padding: 2px; gap: 2px; }
  #view-tabs label { padding: 0.45rem 0.65rem; font-size: 0.85rem; border-radius: 16px; }
  #view-tabs input:checked + label { background: var(--accent-dim); color: var(--accent); }
  #view-tabs input:checked + label::after { display: none; }
  body.clipping #view-tabs { border-color: var(--danger); box-shadow: 0 0 0 1px var(--danger); }

  #topbar-right { gap: 8px; }
  #btn-run {
    min-width: 0;
    margin: 0;
    height: 36px;
    padding: 0 0.9rem;
    border-radius: 18px;
    background: var(--accent);
    border-color: var(--accent);
    color: #06110f;
    font-size: 0.85rem;
  }
  #btn-panel {
    display: inline-flex;
    width: 40px;
    height: 40px;
    color: var(--text);
    font-size: 1.15rem;
  }

  /* readouts: bottom-left pill in portrait; JS moves #hud into the header
     row in landscape (see main.js applyLayout) */
  #hud {
    top: auto;
    right: auto;
    left: calc(12px + env(safe-area-inset-left));
    bottom: calc(14px + env(safe-area-inset-bottom));
    height: 36px;
    padding: 0 12px;
    gap: 0.8rem;
    z-index: 5;
  }
  #hud .readout { font-size: 0.72rem; }
  #ro-peak { font-size: 0.8rem; }
  #topbar #hud { position: static; height: 36px; }

  #btn-settings {
    display: inline-flex;
    align-items: center;
    position: absolute;
    right: calc(12px + env(safe-area-inset-right));
    bottom: calc(14px + env(safe-area-inset-bottom));
    height: 36px;
    padding: 0 12px;
    z-index: 5;
    color: var(--text-dim);
    font-family: var(--font-ui);
    font-size: 0.8rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    cursor: pointer;
  }

  body.fullview #hud, body.fullview #topbar { display: none; }

  /* settings: bottom sheet */
  #panel {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    top: auto;
    height: min(60dvh, 560px);
    background: var(--sheet);
    border: none;
    border-radius: 16px 16px 0 0;
    box-shadow: var(--sheet-shadow);
    transform: translateY(105%);
    transition: transform 0.25s ease;
    z-index: 20;
    padding-bottom: env(safe-area-inset-bottom);
  }

  body.panel-open #panel { transform: translateY(0); }
  #panel.dragging { transition: none; }

  #panel-head { display: block; padding: 8px 12px 0 18px; }

  #panel-handle {
    display: block;
    width: 36px;
    height: 4px;
    border-radius: 2px;
    background: var(--line-strong);
    margin: 0 auto 8px;
  }

  #panel-title { display: flex; align-items: center; gap: 2px; }
  #panel-title h4 {
    flex: 1;
    margin: 0;
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--text-faint);
  }

  #panel-tabs { display: flex; gap: 1.1rem; border-bottom: 1px solid var(--line); margin-top: 4px; }
  #panel-tabs button {
    background: none;
    border: none;
    padding: 0.5rem 0 0.6rem;
    font-family: var(--font-ui);
    font-size: 0.95rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--text-dim);
    cursor: pointer;
  }
  #panel-tabs button.on { color: var(--accent); box-shadow: inset 0 -2px 0 var(--accent); }

  #panel-body { padding: 0.2rem 0 0.6rem; overscroll-behavior: contain; }
  #panel .group { padding: 0.5rem 1.1rem 0.6rem; }
  #panel .group:not(.tab-on) { display: none; }
  #grp-source, body[data-view='spectrogram'] #grp-spectrogram { order: 0; }

  #btn-exit-full { opacity: 0.6; }
}

/* landscape phone: no bottom row; #hud sits in the header row */
@media (max-width: 860px) and (orientation: landscape) {
  #btn-settings { display: none; }
  #view-tabs { margin-left: 0; }
  #topbar { left: calc(12px + max(env(safe-area-inset-left), 44px)); right: calc(12px + max(env(safe-area-inset-right), 44px)); }
  #stage { padding-left: max(env(safe-area-inset-left), 44px); padding-right: max(env(safe-area-inset-right), 44px); }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/livefft/css/app.css
git commit -m "Live FFT layout: rail without boxes on wide screens, pills and bottom sheet on phones"
```

---

### Task 13: State and UI logic

**Files:**
- Modify: `apps/livefft/js/state.js:47` (add `settingsTab`)
- Modify: `apps/livefft/js/ui.js`

- [ ] **Step 1: State**

In `DEFAULTS` after `monitorLevel: 0,` add `settingsTab: 'Analysis',    // active sheet tab on narrow screens`.

- [ ] **Step 2: ui.js — demo picker, sheet, tabs, duplicate buttons, tooltips**

In `populateSources` after the demo optgroup is appended to `selSource`, also fill the start-screen picker:

```js
    const selDemo = $('sel-demo');
    while (selDemo.options.length > 1) selDemo.remove(1);
    for (const d of DEMO_SOURCES) selDemo.appendChild(new Option(d.label, d.id));
```

Replace the `// ---------- panel drawer (mobile) ----------` section (from that comment to just before `return { populateSources };`) with:

```js
  // ---------- settings sheet (narrow) / rail (wide) ----------
  const panel = $('panel');
  const scrim = $('scrim');

  function openPanel() {
    document.body.classList.add('panel-open');
    scrim.hidden = false;
  }

  function closePanel() {
    document.body.classList.remove('panel-open');
    scrim.hidden = true;
  }

  $('btn-panel').addEventListener('click', () => {
    if (document.body.classList.contains('panel-open')) closePanel(); else openPanel();
  });
  $('btn-settings').addEventListener('click', openPanel);
  $('btn-panel-close').addEventListener('click', closePanel);
  scrim.addEventListener('click', closePanel);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePanel();
  });

  // drag the sheet down to close
  const head = $('panel-head');
  let dragY = null;
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    dragY = e.clientY;
    panel.classList.add('dragging');
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener('pointermove', (e) => {
    if (dragY === null) return;
    const dy = Math.max(0, e.clientY - dragY);
    panel.style.transform = `translateY(${dy}px)`;
  });
  const endDrag = (e) => {
    if (dragY === null) return;
    const dy = e.clientY - dragY;
    dragY = null;
    panel.classList.remove('dragging');
    panel.style.transform = '';
    if (dy > 80) closePanel();
  };
  head.addEventListener('pointerup', endDrag);
  head.addEventListener('pointercancel', endDrag);

  // tabs: one per data-tab value among the groups visible in this view
  const TAB_ORDER = ['Analysis', 'Spectrogram', 'Scope', 'Display', 'Axes', 'Source'];
  const tabsNav = $('panel-tabs');

  function updateTabs() {
    const groups = [...document.querySelectorAll('#panel .group')];
    const present = new Set(groups.filter((g) => !g.hidden).map((g) => g.dataset.tab));
    const tabs = TAB_ORDER.filter((t) => present.has(t));
    let active = state.get('settingsTab');
    if (!tabs.includes(active)) active = tabs[0];
    tabsNav.innerHTML = '';
    for (const t of tabs) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t;
      b.classList.toggle('on', t === active);
      b.addEventListener('click', () => state.set('settingsTab', t));
      tabsNav.appendChild(b);
    }
    for (const g of groups) g.classList.toggle('tab-on', g.dataset.tab === active);
  }

  state.on(['settingsTab', 'view'], updateTabs);
  updateTabs();

  // the sheet's title row repeats the header actions that hide on narrow screens
  $('btn-help2').addEventListener('click', () => $('btn-help').click());
  $('btn-theme2').addEventListener('click', () => $('btn-theme').click());
  $('btn-full2').addEventListener('click', () => {
    closePanel();
    $('btn-full').click();
  });

  // ---------- hover tooltips (JS-positioned so the rail never clips them) ----------
  if (window.matchMedia('(hover: hover)').matches) {
    const tip = $('tip');
    let tipFor = null;
    document.addEventListener('pointerover', (e) => {
      const el = e.target.closest?.('[data-tip]');
      if (!el || el === tipFor) return;
      tipFor = el;
      tip.textContent = el.dataset.tip;
      tip.hidden = false;
      const r = el.getBoundingClientRect();
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      let x = Math.min(r.left, window.innerWidth - tw - 8);
      let y = r.bottom + 7;
      if (y + th > window.innerHeight - 8) y = r.top - th - 7;
      tip.style.left = `${Math.max(8, x)}px`;
      tip.style.top = `${Math.max(8, y)}px`;
    });
    document.addEventListener('pointerout', (e) => {
      if (tipFor && !tipFor.contains(e.relatedTarget)) {
        tipFor = null;
        tip.hidden = true;
      }
    });
  }

  return { populateSources, closePanel };
```

Also the existing `updateViewVisibility` must run before `updateTabs` on view changes: it is registered earlier with `state.on('view', ...)`, and listeners fire in registration order, so no change is needed. In `updateViewVisibility`, keep the drawer-close behaviour on the plot: replace the old `$('plot-wrap').addEventListener('pointerdown', ...)` (it was inside the removed section) by adding, after `updateTabs();`:

```js
  $('plot-wrap').addEventListener('pointerdown', closePanel);
```

- [ ] **Step 3: Commit**

```bash
git add apps/livefft/js/state.js apps/livefft/js/ui.js
git commit -m "Live FFT UI: bottom sheet with tabs and drag-to-close, demo picker, JS tooltips"
```

---

### Task 14: main.js — layout detection, HUD re-homing, start buttons, theme-color

**Files:**
- Modify: `apps/livefft/js/main.js`

- [ ] **Step 1: Layout state**

After `let started = false;` add:

```js
// ---------- responsive layout ----------
// narrow: chrome floats over the plot; portrait narrow: y labels inside.
const mqNarrow = window.matchMedia('(max-width: 860px)');
const mqPortrait = window.matchMedia('(orientation: portrait)');
const layout = { compact: false, yInside: false };
const hud = document.getElementById('hud');
const topbar = document.getElementById('topbar');
const stage = document.getElementById('stage');

function applyLayout() {
  layout.compact = mqNarrow.matches;
  layout.yInside = mqNarrow.matches && mqPortrait.matches;
  // landscape phones carry the readouts in the header row
  const inHeader = layout.compact && !mqPortrait.matches;
  if (inHeader && hud.parentElement !== topbar) topbar.insertBefore(hud, document.getElementById('topbar-right'));
  if (!inHeader && hud.parentElement !== stage) stage.appendChild(hud);
}

mqNarrow.addEventListener('change', applyLayout);
mqPortrait.addEventListener('change', applyLayout);
applyLayout();
```

- [ ] **Step 2: Start screen buttons and idle class**

In `startEngine()` after `overlayMsg.hidden = true;` add `document.getElementById('plot-wrap').classList.remove('idle');`.

After `btnRun.addEventListener('click', toggleRun);` add:

```js
document.getElementById('btn-start-mic').addEventListener('click', () => {
  state.set('source', 'mic');
  startEngine();
});
document.getElementById('sel-demo').addEventListener('change', (e) => {
  if (!e.target.value) return;
  state.set('source', e.target.value);
  startEngine();
});
```

- [ ] **Step 3: Tap exits full view on narrow, and pass the layout to views**

In the `PlotInteraction` callbacks object add:

```js
  onTap() {
    if (layout.compact && document.body.classList.contains('fullview')) setFullview(false);
  },
```

In `frame()` replace `view.render(ctx, cssW, cssH, hover, view === views.spectrum ? interaction.rubberBand : null);` with `view.render(ctx, cssW, cssH, hover, view === views.spectrum ? interaction.rubberBand : null, layout);`.

- [ ] **Step 4: Clipping class and theme-color**

In `updateReadouts` replace `lampClip.classList.toggle('on', now - lastClip < 600);` with:

```js
  const clipping = now - lastClip < 600;
  lampClip.classList.toggle('on', clipping);
  document.body.classList.toggle('clipping', clipping);
```

In `applyTheme(theme)` after `document.documentElement.dataset.theme = theme;` add:

```js
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--bg-page').trim();
  document.getElementById('btn-theme2').textContent = THEME_GLYPH[theme];
```

and after the initial `btnTheme.textContent = THEME_GLYPH[...]` line add `document.getElementById('btn-theme2').textContent = btnTheme.textContent;`.

- [ ] **Step 5: Spectrogram colormap uses the page ground**

In `spectrogram.js` `#applyColormap()` replace the body with:

```js
    // light theme gets the reversed variant: silence is the page ground
    const lightBg = document.documentElement.dataset.theme === 'light';
    const th = plotTheme();
    const m = /^#([0-9a-f]{6})$/i.exec(th.bg);
    const ground = m
      ? [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)]
      : [255, 255, 255];
    this.lut = getColormap(this.state.get('sgColormap'), lightBg, ground);
```

- [ ] **Step 6: Commit**

```bash
git add apps/livefft/js/main.js apps/livefft/js/views/spectrogram.js
git commit -m "Live FFT: responsive layout state, start-screen actions, clipping class, theme-color meta"
```

---

### Task 15: Service worker, help text, verification

**Files:**
- Modify: `apps/livefft/sw.js`
- Modify: `apps/livefft/js/ui.js` (help Plot section)

- [ ] **Step 1: Cache**

In `sw.js` set `const CACHE_VERSION = 'livefft-v13';` and add to `PRECACHE` after `'../../shared/js/plot/interaction.js',`:

```js
  '../../shared/js/plot/rows.js',
  '../../shared/js/plot/envelope.js',
  '../../shared/js/dsp/hop.js',
```

- [ ] **Step 2: Help sheet Plot section**

In `buildHelp()` add to the `addSection('Plot', [...])` array, after the 'Full screen' entry:

```js
      ['Levels', 'The spectrum is a density (dBFS per Hz), the spectrogram is amplitude (dBFS). The same tone therefore reads lower on the spectrum — about 15 dB lower at FFT 4096 — and the gap changes with FFT size and window.'],
      ['Settings', 'On a phone, ☰ or the Settings pill opens this sheet; drag it down, tap outside it or press Escape to close.'],
```

- [ ] **Step 3: Run the tests**

Run: `npm test`
Expected: all green.

- [ ] **Step 4: Preview verification**

Start the `static` preview and load `http://localhost:8123/apps/livefft/`. Check at 1280×800, 1024×768, 768×1024, 390×844 and 844×390 in both themes:
- start screen: stack centred, nothing crossing an axis; "Try a demo signal" starts the engine;
- running (two-tone demo): HUD placement (top-right on wide, bottom-left portrait, header row landscape); y labels inside only in portrait; x unit at the right end on narrow;
- sheet opens from ☰ and the Settings pill, tabs switch groups, scrim/✕/Escape close it;
- light theme: button hover is light, spectrogram silence equals the page ground.
Read the console for errors after each state.

- [ ] **Step 5: Commit and push**

```bash
git add apps/livefft/sw.js apps/livefft/js/ui.js
git commit -m "Live FFT: cache bump, help entries for levels and the settings sheet"
git push origin main
```

---

## Self-review

**Spec coverage.** Wide layout (Task 11–12), narrow pills and landscape HUD (12, 14), sheet with tabs/drag/scrim/Escape (13), start screen (11, 12, 14), fullscreen tap-to-exit on narrow (7, 14), CLIP on narrow (12, 14), axis-label rule (2, 8–10, 14), theme tokens and literal removal (1, 9, 12), theme-color meta and status-bar style (11, 14), touch sizes and 16 px controls (1), tooltips unclipped (13), accuracy fixes 1–10 (6, 8, 9, 10, 11), cache bump (15), README (6). `settingsTab` (13). Colormap ground (6, 14).

**Placeholders.** None; every step carries its code.

**Type consistency.** `plotLayout` returns `{m, rect, compact, yInside, xTitle, yTitle}` and the views read exactly those; `rowRanges` returns `{lo, hi}` used by `rowMax(values, lo, hi, r)`; `FrameHopper.due(total)`; `minMaxEnvelope(buf, start, n, cols, outMin, outMax)`; `render(ctx, w, h, hover, rubberBand, layout)` on all three views; `ui.js` returns `{ populateSources, closePanel }` and `main.js` only uses `populateSources`.
