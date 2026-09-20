# Working in this repo

## Ship to main

The site is GitHub Pages served from `main`, and there is no way to try a
change until it is there. So finished work goes to `main` by default:
develop on a branch if you like, but merge it and push `main` at the end of
the task rather than leaving it on a branch or waiting for a pull request.
Say so in the reply, and give the live URL when the deploy is worth checking:

    https://torebutlin.github.io/vibration_apps/

Run `npm test` before pushing `main` — it is the only gate there is.

## Layout

- `apps/<app>/` — one folder per app: its own `index.html`, `css/`, `js/`,
  icons and (for Live FFT) a service worker.
- `shared/js/` — the DSP (`dsp/`), plotting (`plot/`) and audio (`audio/`)
  modules every app imports, and `shared/css/theme.css` for the common look.
- `apps.json` — what the landing page lists; `public: false` keeps an app off
  it without unpublishing it.
- `tests/` — `node --test`, no build step and no browser. Anything worth
  pinning lives in a shared module so it can be tested there.
- `docs/specs/` — the design notes behind the bigger apps.
- `context/` — course material the apps are for; not part of the site.

## House style

Plain ES modules, no framework, no build. Comments say why a thing is the way
it is, not what the line does — the awkward constraint, the number that was
measured, the failure that made it necessary. Keep them at that level and
keep them honest when the code moves.

`npm run serve` (port 8000) is enough to try a change locally, and the repo
has Playwright available for driving it headlessly.
