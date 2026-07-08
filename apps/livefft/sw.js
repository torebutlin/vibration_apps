// Service worker: offline support for the installed app.
// Strategy: network-first for everything (so students always get the
// latest version when online), falling back to the cache offline.
// Bump CACHE_VERSION when shipping changes to force old caches out.

const CACHE_VERSION = 'livefft-v8';

const PRECACHE = [
  './',
  'index.html',
  'app.webmanifest',
  'css/app.css',
  'js/main.js',
  'js/state.js',
  'js/ui.js',
  'js/views/spectrum.js',
  'js/views/spectrogram.js',
  'js/views/scope.js',
  'js/workers/cwt-worker.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  '../../shared/css/theme.css',
  '../../shared/css/fonts.css',
  '../../shared/fonts/Rajdhani-500.woff2',
  '../../shared/fonts/Rajdhani-600.woff2',
  '../../shared/fonts/Rajdhani-700.woff2',
  '../../shared/fonts/JetBrainsMono-400.woff2',
  '../../shared/fonts/JetBrainsMono-500.woff2',
  '../../shared/fonts/JetBrainsMono-700.woff2',
  '../../shared/js/audio/engine.js',
  '../../shared/js/audio/capture-worklet.js',
  '../../shared/js/dsp/fft.js',
  '../../shared/js/dsp/windows.js',
  '../../shared/js/dsp/spectrum.js',
  '../../shared/js/dsp/peaks.js',
  '../../shared/js/dsp/multires.js',
  '../../shared/js/dsp/cwt.js',
  '../../shared/js/plot/axes.js',
  '../../shared/js/plot/colormap.js',
  '../../shared/js/plot/interaction.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});
