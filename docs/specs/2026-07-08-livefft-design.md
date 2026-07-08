# Vibration Apps — infrastructure + Live FFT app design

Date: 2026-07-08. Status: approved direction (autonomous session; user brief in repo history).

## Purpose

A collection of slick, scientifically grounded web apps for undergraduate
vibration teaching, hosted on GitHub Pages, installable as home-screen /
desktop shortcuts (PWA). First app: a live FFT / PSD analyzer using the
device microphone. The `context/` folder holds reference material (teaching
notebooks S2–S7 and an earlier live-FFT prototype) that later apps will grow
from — same infrastructure, no mishmash.

## Infrastructure decisions

- **Static monorepo on GitHub Pages.** One folder per app under `apps/`,
  landing page at the root, no build step. Everything is plain ES modules
  served as-is, so students can read the source and the repo works on Pages
  the moment it goes public.
- **Vanilla JavaScript is the default compute backend.** The notebook demos
  are parameter → compute → animate loops (numpy/matplotlib/ipywidgets);
  that maths runs instantly in JS and gives 60 fps interaction, sub-second
  load, and offline PWA support. **Pyodide remains a per-app escape hatch**
  for anything genuinely scipy-heavy, loaded lazily inside the same shell —
  but the live FFT app is pure JS (Pyodide load time and GC pauses would
  ruin the live feel).
- **Shared layer** (`shared/`) so every app looks and behaves the same:
  - `shared/js/dsp/` — FFT, windows, spectrum pipeline, peaks, multi-res, CWT
  - `shared/js/audio/` — AudioWorklet capture, ring buffer, demo signals
  - `shared/js/plot/` — canvas axes/traces/heatmaps, colormaps, interaction
  - `shared/css/` — design tokens and base styles
- **Tests**: DSP modules are dependency-free ES modules tested with
  `node --test tests/` against known signals (no browser needed).
- **PWA per app**: relative-path manifest + service worker so installs work
  under `https://<user>.github.io/<repo>/apps/<app>/`.

## Live FFT app

### Views (tabs)

1. **Spectrum** — live FFT/PSD with averaging, peak hold, peak labels.
2. **Spectrogram** — scrolling time–frequency heatmap; STFT or CWT mode.
3. **Scope** — time-domain trace (level check, waveform intuition).

### Signal path

Mic via `getUserMedia` with echoCancellation / noiseSuppression /
autoGainControl **off** (measurement-grade as far as the platform allows),
or synthetic **demo sources** (sine, beats, two-tone, log sweep, white/pink
noise, impulse train, tone+noise) so the app works in lectures without mic
permission — and can be exercised headlessly in tests. Audio flows through
an `AudioWorklet` into a main-thread ring buffer (~12 s); the render loop
pulls the newest N samples each frame. Amplitudes are full-scale relative
(dBFS) — mics are uncalibrated, and that is itself a teaching point.

### Spectrum conventions (matching pydvma / standard practice)

All averaging operates on the one-sided power spectrum |X[k]|² (Welch):

- amplitude (peak): `A[k] = 2|X[k]| / (N·CG)`, CG = mean(w)
- amplitude (RMS): `A/√2`
- PSD: `S[k] = 2|X[k]|² / (fs·N·NG)`, NG = mean(w²); halved at DC/Nyquist
- dB: `20·log10(A)` or `10·log10(S)` re full scale

Windows: Hann (default), rectangular, Hamming, Blackman, flat-top (with
correct CG/NG per window). FFT sizes 512–32768. Averaging: off /
exponential (time-constant) / linear-N-then-freeze, plus separate peak-hold
trace with reset. Peak labelling: prominence-filtered local maxima with
parabolic sub-bin interpolation, top-N labelled in Hz.

### Smart resolution

- **Multi-res spectrum mode**: three stitched FFTs (N, 4N, 16N) — regions
  split at fs/8 and fs/32 so relative bandwidth is continuous at the
  boundaries; low frequencies get 16× finer bins at the cost of slower
  response (physics, not implementation).
- **CWT spectrogram mode**: Morlet scaleogram, log-spaced scales
  (selectable bins/octave and ω₀ = 6/12/24 for Q), computed in a Web Worker
  via one long real FFT + per-scale Gaussian bandpass + small complex IFFT
  (frequency-domain decimation). Fixed display latency of 4σ of the widest
  wavelet (~0.2 s at 20 Hz).

### Axes & controls

dB/linear amplitude, linear/log frequency, frequency range presets plus
drag-zoom / pinch / double-tap-reset on the plot, auto or manual dB range.
Settings persist in `localStorage`. Pause/resume freezes the display for
discussion. Responsive layout: sidebar controls on wide screens, bottom
sheet on phones.

### Rendering

Custom Canvas2D (no chart library): devicePixelRatio-aware, nice-number
ticks with minor log ticks, single-pass polyline traces, column-scrolling
offscreen canvas for the spectrogram with viridis/inferno colormaps.
Plotly-style react-per-frame is too slow for 60 fps; direct canvas is
simple and fast.

### Out of scope (this app, for now)

Calibration (abs. SPL), file recording/export, transfer-function / hammer
tests (future app using the same shared layer), multi-channel input.
