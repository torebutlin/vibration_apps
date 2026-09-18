// Pointer interaction for plots: hover crosshair, drag rubber-band x-zoom,
// wheel zoom/pan, pinch zoom, double-click/tap reset.
//
// Works in pixel space via the Axes transforms, so it is agnostic of
// linear/log scaling.

// A second tap this soon after the first is a double tap, not two taps.
// Platform double-click times run to about half a second; a shade under
// that catches a deliberate double tap without making single taps wait
// noticeably for it.
const DOUBLE_TAP_MS = 400;

// A touch double tap also synthesizes a dblclick, a frame or so behind it.
// A reset ignores one that soon after it has already reset: the gesture was
// the same one, and a reset with stages to it would skip one.
const RESET_ECHO_MS = 700;

export class PlotInteraction {
  /**
   * @param {HTMLElement} el element receiving pointer events (the canvas)
   * @param {import('./axes.js').Axes} axes
   * @param {object} cb callbacks:
   *   onXRange(min, max)  — user changed the x range
   *   onYRange(min, max)  — ditto, when zoomAxis is 'y'
   *   onReset()           — user requested reset (double-click/tap)
   *   onHover(px, py|null)— pointer moved (CSS px, relative to canvas), null = left
   *   onTap(px, py)       — pointer released without dragging or pinching.
   *                         On touch it arrives only once the double-tap
   *                         window has passed, so a reset never fires it too.
   */
  constructor(el, axes, cb = {}) {
    this.el = el;
    this.axes = axes;
    this.cb = cb;
    this.drag = null;          // {x0, x1} rubber band, CSS px
    this.pointers = new Map(); // pointerId -> {x, y}
    this.pinch = null;         // {x0px, x1px, min, max}
    this.lastTap = -Infinity;  // no tap yet (0 would read as "just now" at load)
    this.tapTimer = null;      // pending onTap, held for the double-tap window
    this.lastReset = -Infinity;
    // Which axis pinch and wheel zoom. 'x' for a plot whose interesting
    // axis runs across (the spectrum); 'y' where it runs up — the
    // spectrogram, with time across and frequency up. The rubber band is
    // an x gesture, so it is offered only in 'x'.
    this.zoomAxis = 'x';

    el.style.touchAction = 'pan-y'; // keep vertical page scroll on mobile
    el.addEventListener('pointerdown', (e) => this.#down(e));
    el.addEventListener('pointermove', (e) => this.#move(e));
    el.addEventListener('pointerup', (e) => this.#up(e));
    el.addEventListener('pointercancel', (e) => this.#up(e));
    el.addEventListener('pointerleave', () => this.cb.onHover?.(null, null));
    el.addEventListener('wheel', (e) => this.#wheel(e), { passive: false });
    el.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (performance.now() - this.lastReset < RESET_ECHO_MS) return;
      this.#reset();
    });
  }

  #reset() {
    this.lastReset = performance.now();
    this.cb.onReset?.();
  }

  #pos(e) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /**
   * The axis a zoom gesture acts on, with the transforms it needs: where a
   * pointer sits along it, the 0..1 fraction of the plot that is (upwards
   * for y), and the data value there.
   */
  #zoomed() {
    const vertical = this.zoomAxis === 'y';
    const r = this.axes.rect;
    return {
      vertical,
      axis: vertical ? this.axes.y : this.axes.x,
      origin: vertical ? r.y : r.x,
      length: vertical ? r.h : r.w,
      pos: (p) => (vertical ? p.y : p.x),
      t: (px) => (vertical ? 1 - (px - r.y) / r.h : (px - r.x) / r.w),
      toData: (px) => (vertical ? this.axes.pxToY(px) : this.axes.pxToX(px)),
      set: (min, max, log) => (vertical ? this.axes.setY(min, max, log) : this.axes.setX(min, max, log)),
      emit: (a, b) => {
        const min = Math.min(a, b);
        const max = Math.max(a, b);
        if (vertical) this.cb.onYRange?.(min, max);
        else this.cb.onXRange?.(min, max);
      },
    };
  }

  #down(e) {
    const p = this.#pos(e);
    try { this.el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    this.pointers.set(e.pointerId, p);
    this.tapCandidate = this.pointers.size === 1;

    if (this.pointers.size === 2) {
      // enter pinch mode, cancel rubber band
      this.tapCandidate = false;
      this.drag = null;
      const z = this.#zoomed();
      const [a, b] = [...this.pointers.values()];
      this.pinch = {
        p0: Math.min(z.pos(a), z.pos(b)),
        p1: Math.max(z.pos(a), z.pos(b)),
        min: z.axis.min,
        max: z.axis.max,
        log: z.axis.log,
      };
      return;
    }

    // Double-tap reset: a finger down soon after a tap ended. Only a tap
    // arms this (see #up), so a finger that comes back down after a drag or
    // a pinch does not undo the zoom it has just made. The first tap is
    // still pending, so drop it: the gesture is a reset, not a tap repeated.
    if (e.pointerType === 'touch' && performance.now() - this.lastTap < DOUBLE_TAP_MS) {
      this.lastTap = -Infinity;    // a third tap starts over
      this.tapCandidate = false;   // nor is the second half a tap of its own
      this.#cancelPendingTap();
      this.#reset();
      return;
    }
    // the rubber band selects a span across the plot: an x gesture
    if (this.zoomAxis === 'x' && this.axes.inRect(p.x, p.y)) {
      this.drag = { x0: p.x, x1: p.x, moved: false };
    }
  }

  #move(e) {
    const p = this.#pos(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);

    if (this.pinch && this.pointers.size === 2) {
      const z = this.#zoomed();
      const [a, b] = [...this.pointers.values()];
      const n0 = Math.min(z.pos(a), z.pos(b));
      const n1 = Math.max(z.pos(a), z.pos(b));
      if (n1 - n0 > 20 && this.pinch.p1 - this.pinch.p0 > 20) {
        // map so the two anchor points stay under the fingers
        const saved = { ...z.axis };
        // original data coords of the pinch anchors (in a temp axes view)
        z.set(this.pinch.min, this.pinch.max, this.pinch.log);
        const d0 = z.toData(this.pinch.p0);
        const d1 = z.toData(this.pinch.p1);
        z.set(saved.min, saved.max, saved.log); // restore; app applies via callback
        // find the new range that puts d0 at n0 and d1 at n1
        const t0 = z.t(n0);
        const t1 = z.t(n1);
        let min;
        let max;
        if (this.pinch.log) {
          const L0 = Math.log(d0);
          const L1 = Math.log(d1);
          const a2 = (L1 - L0) / (t1 - t0);
          const b2 = L0 - a2 * t0;
          min = Math.exp(b2);
          max = Math.exp(a2 + b2);
        } else {
          const a2 = (d1 - d0) / (t1 - t0);
          const b2 = d0 - a2 * t0;
          min = b2;
          max = a2 + b2;
        }
        z.emit(min, max);
      }
      return;
    }

    if (this.drag) {
      this.drag.x1 = p.x;
      if (Math.abs(this.drag.x1 - this.drag.x0) > 4) this.drag.moved = true;
      this.cb.onHover?.(p.x, p.y);
      return;
    }
    this.cb.onHover?.(p.x, p.y);
  }

  #up(e) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    let tapped = this.tapCandidate && this.pointers.size === 0;
    this.tapCandidate = false;
    if (this.drag) {
      const { x0, x1, moved } = this.drag;
      this.drag = null;
      if (moved) tapped = false;
      if (moved && Math.abs(x1 - x0) > 12) {
        const min = this.axes.pxToX(Math.min(x0, x1));
        const max = this.axes.pxToX(Math.max(x0, x1));
        this.cb.onXRange?.(min, max);
      }
    }
    if (tapped) {
      const p = this.#pos(e);
      if (e.pointerType === 'touch') {
        // a tap, and only a tap, opens the double-tap window; until it
        // closes the tap is held back, so a reset does not also do whatever
        // a single tap does (in Live FFT, leave the full-screen view)
        this.lastTap = performance.now();
        this.#cancelPendingTap();
        this.tapTimer = setTimeout(() => {
          this.tapTimer = null;
          this.cb.onTap?.(p.x, p.y);
        }, DOUBLE_TAP_MS);
      } else {
        this.cb.onTap?.(p.x, p.y);
      }
    }
  }

  #cancelPendingTap() {
    if (this.tapTimer === null) return;
    clearTimeout(this.tapTimer);
    this.tapTimer = null;
  }

  #wheel(e) {
    if (!this.axes.inRect(...Object.values(this.#pos(e)))) return;
    e.preventDefault();
    const p = this.#pos(e);
    const z = this.#zoomed();
    const r = this.axes.rect;
    if (!z.vertical && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      // horizontal pan
      const shift = e.deltaX / r.w;
      const t0 = shift;
      const t1 = 1 + shift;
      const min = this.axes.pxToX(r.x + t0 * r.w);
      const max = this.axes.pxToX(r.x + t1 * r.w);
      this.cb.onXRange?.(min, max);
    } else {
      // zoom around the cursor
      const f = Math.exp(e.deltaY * 0.002);
      const c = z.pos(p);
      const lo = c - (c - z.origin) * f;
      const hi = c + (z.origin + z.length - c) * f;
      z.emit(z.toData(lo), z.toData(hi));
    }
  }

  /** Rubber band rectangle in CSS px, or null. For the renderer to draw. */
  get rubberBand() {
    if (!this.drag || !this.drag.moved) return null;
    return { x0: Math.min(this.drag.x0, this.drag.x1), x1: Math.max(this.drag.x0, this.drag.x1) };
  }
}
