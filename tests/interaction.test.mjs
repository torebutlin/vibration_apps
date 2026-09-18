import test from 'node:test';
import assert from 'node:assert/strict';
import { PlotInteraction } from '../shared/js/plot/interaction.js';

// A stand-in for the canvas: collects the listeners and lets a test send
// pointer events to them. The plot sits at the origin, 400 x 300.
function stubElement() {
  const handlers = new Map();
  return {
    style: {},
    handlers,
    addEventListener(type, fn) { handlers.set(type, fn); },
    setPointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }),
    send(type, e) { handlers.get(type)?.({ pointerId: 1, pointerType: 'touch', clientX: 200, clientY: 150, ...e }); },
  };
}

// x maps 1 px to 1 Hz across; y runs 0 at the bottom to 300 up the plot
const stubAxes = {
  x: { min: 0, max: 1000, log: false },
  y: { min: 0, max: 300, log: false },
  rect: { x: 0, y: 0, w: 400, h: 300 },
  inRect: () => true,
  pxToX: (px) => px,
  pxToY: (px) => 300 - px,
  setX() {},
  setY() {},
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for a condition, since a timer can run late on a loaded machine. */
async function waitFor(fn, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(20);
  }
  return false;
}

/** One tap: down then up, at the same place. */
function tap(el) {
  el.send('pointerdown');
  el.send('pointerup');
}

test('a single tap is reported, once the double-tap window has passed', async () => {
  const el = stubElement();
  const taps = [];
  new PlotInteraction(el, stubAxes, { onTap: (x, y) => taps.push([x, y]) });
  tap(el);
  assert.deepEqual(taps, [], 'not yet: it could still become a double tap');
  assert.ok(await waitFor(() => taps.length === 1), 'the tap arrives once it cannot');
  assert.deepEqual(taps, [[200, 150]]);
});

test('a double tap resets and does not also count as a tap', async () => {
  const el = stubElement();
  const taps = [];
  let resets = 0;
  new PlotInteraction(el, stubAxes, { onTap: () => taps.push(1), onReset: () => { resets++; } });
  tap(el);
  await sleep(20);
  tap(el);
  assert.equal(resets, 1, 'the second tap resets');
  await sleep(600);
  assert.deepEqual(taps, [], 'the first one is dropped, not delivered late');
});

test('two taps far enough apart are two taps, not a reset', async () => {
  const el = stubElement();
  const taps = [];
  let resets = 0;
  new PlotInteraction(el, stubAxes, { onTap: () => taps.push(1), onReset: () => { resets++; } });
  tap(el);
  await sleep(450);
  tap(el);
  assert.ok(await waitFor(() => taps.length === 2), `taps: ${taps.length}`);
  assert.equal(resets, 0);
});

test('a tap straight after a drag is not a double tap', async () => {
  const el = stubElement();
  let resets = 0;
  new PlotInteraction(el, stubAxes, { onReset: () => { resets++; } });
  // zoom by dragging, then put a finger back down: the zoom stands
  el.send('pointerdown', { clientX: 50 });
  el.send('pointermove', { clientX: 300 });
  el.send('pointerup', { clientX: 300 });
  await sleep(30);
  tap(el);
  assert.equal(resets, 0);
});

test('a mouse tap is reported straight away; dblclick does the reset', () => {
  const el = stubElement();
  const taps = [];
  let resets = 0;
  new PlotInteraction(el, stubAxes, { onTap: () => taps.push(1), onReset: () => { resets++; } });
  el.send('pointerdown', { pointerType: 'mouse' });
  el.send('pointerup', { pointerType: 'mouse' });
  assert.equal(taps.length, 1, 'no waiting on a pointer that has dblclick');
  el.send('dblclick', { preventDefault() {} });
  assert.equal(resets, 1);
});

test('the dblclick a touch double tap synthesizes resets once, not twice', async () => {
  const el = stubElement();
  let resets = 0;
  new PlotInteraction(el, stubAxes, { onReset: () => { resets++; } });
  tap(el);
  await sleep(20);
  tap(el);
  el.send('dblclick', { preventDefault() {} }); // the browser's echo
  assert.equal(resets, 1);
});

// ---------- zoomAxis: the spectrogram's frequency axis runs up ----------

test('pinching apart along y zooms the y axis, not the x one', () => {
  const el = stubElement();
  const x = [];
  const y = [];
  const it = new PlotInteraction(el, stubAxes, { onXRange: (a, b) => x.push([a, b]), onYRange: (a, b) => y.push([a, b]) });
  it.zoomAxis = 'y';
  el.send('pointerdown', { pointerId: 1, clientY: 100 });
  el.send('pointerdown', { pointerId: 2, clientY: 200 });
  // fingers move apart: the band between them fills more of the plot
  el.send('pointermove', { pointerId: 1, clientY: 50 });
  el.send('pointermove', { pointerId: 2, clientY: 250 });
  assert.equal(x.length, 0, 'the x axis is left alone');
  assert.equal(y.length, 2);
  const [min, max] = y.at(-1);
  // fingers 100 px apart moved to 200: the range they hold between them
  // now fills twice the plot, so the axis spans half of what it did
  assert.ok(Math.abs(max - min - 150) < 0.01, `span ${max - min}`);
  // and the values that were under the fingers have stayed under them
  const valueAtPx = (px) => min + (1 - px / 300) * (max - min);
  assert.ok(Math.abs(valueAtPx(50) - 200) < 0.01, `at the top finger: ${valueAtPx(50)}`);
  assert.ok(Math.abs(valueAtPx(250) - 100) < 0.01, `at the bottom one: ${valueAtPx(250)}`);
});

test('the wheel zooms whichever axis is set', () => {
  const el = stubElement();
  const y = [];
  const it = new PlotInteraction(el, stubAxes, { onYRange: (a, b) => y.push([a, b]) });
  it.zoomAxis = 'y';
  el.send('wheel', { deltaX: 0, deltaY: -100, clientY: 150, preventDefault() {} });
  const [min, max] = y.at(-1);
  assert.ok(min > 0 && max < 300, `zoomed in about the cursor: ${min}..${max}`);
  assert.ok(Math.abs((min + max) / 2 - 150) < 1, 'and around it');
});

test('no rubber band in y mode: a drag does not zoom x', async () => {
  const el = stubElement();
  const x = [];
  const it = new PlotInteraction(el, stubAxes, { onXRange: (a, b) => x.push([a, b]) });
  it.zoomAxis = 'y';
  el.send('pointerdown', { clientX: 50 });
  el.send('pointermove', { clientX: 300 });
  el.send('pointerup', { clientX: 300 });
  assert.deepEqual(x, []);
});

test('a drag is not a tap', async () => {
  const el = stubElement();
  const taps = [];
  const ranges = [];
  new PlotInteraction(el, stubAxes, { onTap: () => taps.push(1), onXRange: (a, b) => ranges.push([a, b]) });
  el.send('pointerdown', { clientX: 50 });
  el.send('pointermove', { clientX: 300 });
  el.send('pointerup', { clientX: 300 });
  await sleep(600);
  assert.deepEqual(taps, []);
  assert.deepEqual(ranges, [[50, 300]]);
});
