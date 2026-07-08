# Vibration Apps

Interactive web apps and demos for undergraduate vibration teaching.
Everything runs client-side (plain ES modules, no build step) and is
designed to be hosted on GitHub Pages and installed as an app on phones
and laptops (PWA).

**Apps**

| App | Description |
| --- | --- |
| [Live FFT](apps/livefft/) | Real-time spectrum analyzer: FFT/PSD with averaging and peak hold, STFT + Morlet-wavelet spectrograms, triggered scope. Microphone input with processing disabled, or built-in demo signals. |

## Running locally

Any static server works (ES modules don't load from `file://`):

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```

Note: microphone access requires a secure context — `localhost` is fine,
but other devices on your network will need HTTPS (or use the demo
signal sources).

## Deploying to GitHub Pages

1. Make the repository public (Settings → General → Danger Zone), or use
   a plan that allows Pages on private repos.
2. Settings → Pages → Source: **Deploy from a branch**, branch `main`,
   folder `/ (root)`.
3. The site appears at `https://<user>.github.io/vibration_apps/`.

All asset paths are relative, so the site works unchanged under the
`/vibration_apps/` subpath. The service worker gives each app offline
support after the first visit; bump `CACHE_VERSION` in an app's `sw.js`
when shipping significant changes.

## Repository layout

```
index.html          landing page (app gallery)
apps/<app>/         one folder per app (self-contained PWA)
shared/             design system + libraries shared by all apps
  css/              theme tokens, fonts
  js/dsp/           FFT, windows, spectrum pipeline, peaks, multires, CWT
  js/audio/         AudioWorklet capture, demo signal sources
  js/plot/          canvas axes, colormaps, zoom/crosshair interaction
tests/              DSP unit tests (no browser needed)
docs/specs/         design documents
context/            reference material (teaching notebooks, prototypes)
```

## Tests

DSP code is verified against known signals (Parseval, sine amplitude
recovery, white-noise PSD levels, wavelet localization):

```sh
npm test        # = node --test tests/
```

## Design notes

- **Vanilla JS, no frameworks** — instant load, 60 fps canvas rendering,
  and the source stays readable for students. Pyodide remains an option
  for future scipy-heavy demos, loaded per-app.
- **Scaling conventions** (matching standard measurement practice): Hann
  window by default with correct coherent/noise gain corrections;
  amplitude spectra read sine peak (or RMS) amplitude directly; PSD is
  one-sided in FS²/Hz. Levels are dBFS — mics are uncalibrated.
- **Multi-resolution**: the spectrum's multi-res mode stitches 3 FFT
  lengths (N, 4N, 16N) with boundaries at fs/8 and fs/32; the
  spectrogram's wavelet mode is a Morlet CWT computed in a Web Worker.
