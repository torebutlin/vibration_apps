# Live FFT — UI refresh and accuracy fixes

Date: 2026-09-05. Status: direction approved by Tore in conversation
(Direction A on wide screens, Direction B on phones, y-axis labels inside
only in phone portrait); this spec awaits his review before planning.

Mockups: https://claude.ai/code/artifact/23f481a7-6a18-4d70-bcb9-26ec41dd84cb
(static frames at device size, dark and light). The review that led here
found the chrome problems below plus a set of verified bugs; both are fixed
in one pass because they touch the same files.

## Goals

- One frame, not four: the plot is the only boxed thing on screen.
- On phones every pixel that can be trace is trace; chrome floats over it.
- One ground per theme so the trace and the colourmap are the only colour.
- Keep the bench-instrument identity: Rajdhani, JetBrains Mono, phosphor
  teal, amber peaks, the pulsing dot.
- Fix the verified accuracy bugs in the same pass.

Out of scope: new views, colourmap changes, the demo shell, calibration.

## Layout

Breakpoint stays at 860 px viewport width (`--narrow` below). Tablets in
portrait are narrow; tablets in landscape and laptops are wide.

### Wide (Direction A)

- Header, 48 px, page background, no border: wordmark + status dot;
  view switcher as a flat segmented control (active item accent text with
  a 2 px underline, no pill background); right cluster of ghost icon
  buttons `?` `⤢` `☀` (no border, dim text, accent on hover) and the
  primary Start/Pause button. The CLIP lamp stays, left of the icons.
- Stage: the plot canvas fills the stage with no border, radius, padding
  or inset shadow. The plot background equals the page background. The
  canvas frame line is the only edge.
- Readouts (`fs`, `Δf`, `avg`, `peak`) become a HUD line drawn as DOM
  chips over the plot's top-right corner (mono, 11 px, dim, peak in
  accent). The status bar and its hint string are removed; the hint text
  moves into the help sheet's "Plot" section, which already exists.
- Rail: 272 px, page background, single 1 px left hairline, 14/18 px
  padding, groups separated by 18 px space with eyebrow titles and no rule
  lines. Row height 36 px. Controls keep their borders but the segmented
  control loses its outer box (2 px inset on `--bg2`). Fine print stays
  at the bottom of the rail.
- Full-screen mode (`body.fullview`) is unchanged.

### Narrow (Direction B)

- No header. The plot fills the viewport inside safe-area insets
  (`env(safe-area-inset-*)`); `viewport-fit=cover` is already set.
- Top row of floating pills, 12 px from the edges (plus insets): view
  switcher (segmented pill), spacer, Start/Pause (solid accent pill),
  round `☰` button. Pills are `--pill` (78–82% panel colour) with a
  hairline and `backdrop-filter: blur(6px)`.
- Portrait: bottom row 40 px above the home indicator: HUD readouts pill
  left, "⚙ Settings" pill right (same action as `☰`).
- Landscape: the HUD pill joins the top row after the switcher; no bottom
  row. The top row starts to the right of the y-axis margin
  (`left: calc(inset + 66px)`) so it never covers axis labels.
- CLIP: the status dot inside the view-switcher pill turns red while
  clipping (replaces the lamp on narrow).
- Full-screen: the `⤢` action in the sheet title row hides the pills; a
  tap on the plot brings them back. No separate fullview layout on narrow.

### Settings sheet (narrow)

Replaces the slide-over drawer.

- Bottom sheet, `--sheet` background, 16 px top radius, shadow, drag
  handle, height 60% of the viewport (max 560 px), scrolls internally
  (`overscroll-behavior: contain`).
- Title row: "SETTINGS" eyebrow, then `?` `⤢` `☀` ghost icons, then `✕`.
- Tabs under the title: Analysis · Display · Axes · Source in the
  spectrum view; Spectrogram · Axes · Source in the spectrogram view;
  Scope · Source in the scope view. Tabs are the existing `.group`
  elements shown one at a time; the existing `data-views` visibility
  logic and the row re-homing in `ui.js` are unchanged.
- Opens from `☰` or the Settings pill; closes on scrim tap, `✕`, Escape,
  or a downward drag of more than 80 px on the handle/title.
- Last open tab is remembered in state (`settingsTab`).

### Start screen

The overlay card is replaced by an empty state drawn inside the plot,
same DOM element re-styled:

- Grid and axes drawn dimmed (labels use `--faint`) until running.
- Centred stack, max-width 280 px: wordmark (22 px), one line
  "Spectrum, spectrogram and scope from the microphone, in dBFS.", then
  two 44 px buttons: solid "▶ Start · microphone" and ghost
  "Try a demo signal ▾". The demo button is a styled `<select>` listing
  `DEMO_SOURCES`; choosing one sets `source` and starts.
- The header/pill Start still works as today (uses the selected source).
- The stack is narrower than the plot's inner area on every device, so it
  never crosses an axis. Verified sizes: 390 px portrait, 844 px landscape.

## Axis labels

Implemented once in `shared/js/plot/axes.js` so all three views and the
demo shell share it. `Axes.layout(w, h, { yInside })` returns the margins
and the draw options; views stop hard-coding `{l:64,r:14,t:14,b:46}`.

- x-axis tick labels are always outside, below the plot. On narrow
  screens the axis title is dropped and the unit is written at the right
  end of the tick row (`Hz`, `s`, `ms`). Wide keeps the centred title.
- y-axis: outside with the rotated title on wide and on narrow landscape
  (margin left 58 px). Inside the plot on narrow portrait only: labels at
  the left edge, left-aligned, with a 3 px halo in the plot background so
  they read over grid lines and spectrogram bands; the axis quantity is
  written once in the top-left corner (`PSD dBFS/Hz`, `FREQUENCY Hz`,
  `SIGNAL FS`). Margin left 10 px.
- Portrait is `matchMedia('(orientation: portrait)')` on a narrow
  viewport; orientation changes re-run layout on the next frame.
- Legend moves to the bottom-left when labels are inside (the top-left is
  taken by the quantity label); peak tags clamp inside the plot as today.
- Spectrogram colour-scale note reads `amplitude dBFS` (see fixes, 7).

## Theme

Tokens in `shared/css/theme.css`; every literal colour in `app.css` and
the views moves to a token.

Dark: `--bg-inset` = `--bg-page` (#0a0d14 for both, one step lighter than
today's #07090f so the pills have somewhere to sit); `--bg-panel` =
page; new `--pill: rgba(16,21,31,.78)`, `--sheet: #10151f`.

Light: `--bg-page` and `--bg-inset` #f4f6f9; `--bg-panel` and
`--bg-raised` #ffffff; `--text` #1c2433; `--text-dim` #5b6980;
`--text-faint` #8d99ad; `--line` rgba(28,36,51,.14); `--accent`
#0c8f84; `--amber` #b45f06; grid rgba(28,36,51,.07) / .15; frame .35;
`--pill: rgba(255,255,255,.82)`, `--sheet: #ffffff`. The reversed inferno
already fades to white; it will fade to the page ground instead
(`getColormap(name, reversed, groundRgb)`).

Literals removed: `.btn:hover` background, `.seg` checked shadow, range
thumb glow, `#toast` border, the rubber-band fill/stroke in
`spectrum.js` (new `--plot-rubber` tokens), `#panel` drawer shadow.
`applyTheme()` also updates `<meta name="theme-color">`;
`apple-mobile-web-app-status-bar-style` is set to `black-translucent` so
the installed app draws under the status bar and the insets do the rest.

## Controls and text

- Form controls (`select`, `input`) are 16 px on narrow screens so iOS
  does not zoom on focus; labels 15 px; readouts 12 px minimum.
- Tap targets on narrow: rows 44 px, segmented items 36 px tall with
  8 px vertical hit padding, switch hit area 44 × 44, buttons 40 px.
- The `?` help sheet keeps every `data-tip` text; the tooltip CSS is
  unchanged on hover devices but the tooltip is clipped by the rail's
  scroll container today, so it gets `position: fixed` placement.

## Accuracy fixes (same pass)

1. Listen: `capture-worklet.js` copies input channel 0 to output channel 0
   every quantum, so the monitor gain gets signal.
2. Spectrogram rows: `#rebuild` computes `[bLo, bHi]` per row from the
   half-way frequencies to the neighbouring rows, and the column writer
   takes the maximum power across that range (STFT) or the maximum
   amplitude across the scale range (CWT). Single-bin rows behave as now.
   Test: a windowed tone at any of 600 frequencies loses < 0.5 dB at
   N = 32768 over 20–5000 Hz.
3. Catch-up: `toEmit` is clamped to `min(backlog, COLS)` before
   `sinceCol` is reduced, and the duplicated columns cover the whole
   backlog so the time axis stays true after a stall.
4. Averaging hops on samples: the spectrum view processes a frame only
   when at least `N/2` new samples have arrived since the last processed
   frame (50% overlap); rendering still happens every animation frame from
   the stored spectra. `avgCount` therefore counts data frames and the
   linear target means the same thing at 60 Hz, 120 Hz and on a throttled
   phone. Exponential alpha keeps using elapsed time between processed
   frames. Multi-res uses the same rule with its base size. Test: 16
   linear averages of white noise reduce the bin variance by close to 16.
5. Multi-res wording (tooltip, README, `multires.js` header): each region
   spans the same range of relative resolution, 2/N at its top to 8/N at
   its bottom, and the resolution jumps by 4× at each dashed boundary.
6. Peak hold behaviour is unchanged (it holds the displayed, averaged
   trace, which is what Tore wants). Tooltip: "Keeps the maximum of the
   displayed trace since the last reset. With averaging on it holds the
   averaged level; switch averaging off to catch short transients."
7. dB references: the spectrogram note becomes `amplitude dBFS`, and the
   help sheet's Plot section gains one entry explaining that the spectrum
   is a density (dBFS/Hz) while the spectrogram is amplitude (dBFS), so
   the same tone reads about 15 dB lower on the spectrum at N = 4096.
8. Scope: when there are more than two samples per pixel column the trace
   is drawn as a min/max envelope per column instead of every k-th sample.
9. Flat-top comment in `windows.js`: these are the MATLAB `flattopwin`
   coefficients (ENBW ≈ 3.77 bins), not SFT3F.
10. CWT `f min` keeps its 5 Hz floor; the tooltip adds that phones lag
    noticeably below about 20 Hz.

## Files

`apps/livefft/index.html`, `css/app.css`, `js/main.js`, `js/ui.js`,
`js/state.js` (`settingsTab`), `js/views/spectrum.js`, `spectrogram.js`,
`scope.js`, `shared/css/theme.css`, `shared/js/plot/axes.js`,
`shared/js/plot/colormap.js`, `shared/js/audio/capture-worklet.js`,
`shared/js/dsp/spectrum.js`, `multires.js`, `windows.js`, `README.md`,
`tests/spectrum.test.mjs` (hop-count and variance tests),
`tests/plot.test.mjs` (new: row pooling and layout margins),
`apps/livefft/sw.js` (bump `CACHE_VERSION`).

## Verification

- `npm test` green with the new tests.
- Preview browser at 1280×800, 1024×768, 768×1024, 390×844, 844×390 in
  both themes, start and running states, sheet open; the same shots that
  produced the review.
- On a real phone (Safari iOS and Chrome Android) as an installed app:
  safe areas, no zoom on select focus, sheet drag, Listen audible.
