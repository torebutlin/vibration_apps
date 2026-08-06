# Vibration Apps — roadmap

Date: 2026-08-06. Source material: `context/3c6/` (16 notebooks + 1 .py,
sessions S2–S7) and `context/4c6/` (20 notebooks + 1 .m), fully inventoried.

## Two archetypes

The material splits cleanly into:

- **Instruments** — general-purpose measurement apps in the Live FFT mould:
  live audio in/out, instrument-panel controls, useful beyond any one
  lecture. Installable PWAs, listed prominently.
- **Demos** — single-concept interactives: parameter sliders → recompute →
  animate/plot/hear. One idea each, built on a shared "demo shell" so each
  is a small file. Grouped by course on the landing page.

Every new app ships with `"public": false` in `apps.json` (unlisted draft,
reachable by direct URL, visible in the gallery via `?drafts=1`) until
flipped public.

## Instruments

| # | App | Consolidates | Notes |
|---|-----|--------------|-------|
| I1 | **Live FFT** ✅ shipped | `tblivefft.html` ≡ `4c6/live_fft.html` | |
| I2 | **Signal logger** — triggered/pretriggered capture of N seconds, replay, zoom, spectrum of the captured record, CSV/WAV export | `S2_guitar_plucks`, `S7_effect_of_mass`, basic `logger.ipynb` use | The pydvma Oscilloscope+Logger workflow. Mostly reuses Live FFT's shared layer plus a capture buffer + snapshot UI. |
| I3 | **FRF analyzer** — play stepped sine / chirp / band-limited noise / any audio out of the speakers, record the mic, compute H(f)=Y/X with averaging and coherence | `S3_TF_measurement(.py/.ipynb)`, `logger_coherence`, `S7_effect_of_mass` (with/without-mass preset), measurement half of `Helmholtz_measurement_and_prediction` | The flagship second instrument. New DSP: coherence, H1 estimator (both trivial on existing FFT); the real work is output/input alignment in Web Audio (measure loop latency once with a reference chirp). |
| I4 | **Reverb meter** — clap-triggered capture → Schroeder backward integration → EDT/T20/T30 with regression fits | merge `reverb` (better estimator) + `reverb2` (clap trigger, better presentation) | Small, very classroom-friendly. Shares capture code with I2. |
| I5 | **Tone lab** — additive synthesis with per-partial amplitude/detune controls, presets, and spectrum view | `S2_notes_clangs` (note vs clang), `S3_equal_temperament` (temperament beats), `harmonics`, `Untitled.ipynb` Q2 (string inharmonicity ω_n(1+½(nπ/a)²EI/P)), tone playback from `room_modal_density` | "Hear the physics" app: presets for harmonic note, detuned clang, just vs equal-tempered third, stiff-string inharmonicity. Pure Web Audio. |

## Demos

**3C6** (by session)

- D1 *Plucked string* — pluck position + number of modes → animated modal
  sum, optional audio of the truncated series (`S2_transient_response`).
- D2 *d'Alembert waves* — f(x−ct) + g(x+ct) with mirror-image reflections
  (`S4_Dalembert`).
- D3 *Dispersion & group velocity* — Gaussian packet with cg = 2c, plus the
  two-tone beating view with markers riding envelope vs carrier
  (`S4_dispersive_waves`, `S4_dispersive_waves_beating`).
- D4 *Beam wave types* — the four solutions e^{±kx}, e^{±ikx} animated
  (`S5_beam_waves`).
- D5 *Discrete vs continuous* — N masses on a string vs exact frequencies,
  N slider (`S6_discrete_approximation`; the tridiagonal has a closed-form
  spectrum, so no eigensolver needed in JS).
- D6 *Modal sum vs closed form* — add-one-mode-at-a-time button converging
  onto the exact receptance (`S6_transfer_function_equivalance`).
- D7 *Hammer pulse & instrumentation filters* — half-sine pulse through
  HP/LP filters, time + spectrum views (`S3_hammer_pulse_spectrum`; needs
  the small IIR helper below).

**4C6** (by unit, as assessed from the jumble)

*Damping:*
- D8 *Damping treatment designer* — free-layer (Oberst) vs constrained-layer
  (RKU) η_eff vs thickness, mode-number slider (`Surface_damping_treatments`;
  `constrainedlayer.m` is its MATLAB ancestor — drop).
- D9 *Friction (microslip) damping* — amplitude-dependent η and the bent FRF
  family (`friction_damped_example`; scalar solves port fine).
- D10 *Complex modes* — 3-DOF chain with non-proportional damping: real vs
  state-space complex modes (`first_order_damped_systems`). Port hurdle:
  needs a small complex eigensolver (only place in the collection). Later.
- D11 *Decay envelope methods* — square+LPF vs Hilbert vs Schroeder on a
  known decay (`envelope_methods`). Pairs with the reverb meter.

*Modal testing:*
- D12 *Circle fit / Nyquist* — one mode as receptance/mobility/accelerance
  circles, half-power points, frequency spacing (`circle_fitting`).
- D13 *Eigenvalue interlacing* — coupled receptance 1/(1/G1+1/G2) with a
  re-roll button (`Interlacing`).
- D14 *Beam explorer* — Euler–Bernoulli beam with BC selector: free-free
  (`S5_coscosh` ≡ `S5_coscosh_moodle`) and cantilever with the 3×3 FRF
  matrix and reciprocity (`cantilever_beam`). One app serves both courses.

*Acoustics:*
- D15 *Room modes & Schroeder frequency* — Weyl mode-count terms, Schroeder
  frequency, play tones below/above it (`room_modal_density`).
- D16 *Helmholtz resonator* — bottle geometry → predicted frequency with
  end correction (`Helmholtz_prediction`; measurement mode lives in I3/I2).
- D17 *Membrane & plate modes* — rectangular mode shapes animated (canvas,
  not matplotlib's pathological 1000×1000 redraw) + circular via Bessel
  zeros (`membrane_modes`, `bessel_functions`).

*Wave control:*
- D18 *ABH taper* — exponential-taper profile/mass tool (`ABH profile`).
  Low value as a web app; lowest priority.

Not ported: `Untitled.ipynb` (examples-paper scratchpad — its two good
ideas are absorbed into I5 and D8).

## Shared infrastructure to add (as needed, not up front)

- `shared/js/num/` — scalar root finder (bracketed Newton/bisection: serves
  D9, D14, D18), Bessel J_n + zeros (D17), small IIR designer +
  zero-phase filtering (D7, D11), complex eigensolver (D10 only, last).
- `shared/js/demo-shell/` — the demo chassis: header/title, canvas,
  slider/checkbox panel from theme controls, play-pause animation loop,
  same theming/PWA plumbing. Build with D1–D3 and refine.
- `shared/js/audio/` — additive-synthesis helper with envelopes (I5, D1,
  D15); capture/record buffer with pretrigger (I2, I4, I3).

## Suggested build order

1. **Demo shell + quick wins** (all closed-form): D2, D3, D5, D8, D13 —
   five demos that prove the shell across both courses.
2. **Sound**: I5 tone lab, then D1 plucked string (shell + audio synth).
3. **Instruments**: I4 reverb meter (small), then I3 FRF analyzer (the big
   one), absorbing I2's capture machinery on the way (I2 may ship as a
   by-product).
4. **Modal testing set**: D14 beam explorer, D12 circle fit, D6, D7, D11.
5. **Specialist tail**: D15, D16, D17 (Bessel), D9, D10 (complex eig), D18.

Each app: draft flag on, verify on desktop + phone, then Tore flips
`"public": true` in `apps.json`.
