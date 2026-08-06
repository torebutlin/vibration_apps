// Demo shell: the chassis for one-concept teaching demos.
//
// Builds the page (top bar, canvas stage, control panel, help sheet,
// theme + full-screen controls), runs a play/pause-aware animation loop,
// and offers a small declarative API for controls:
//
//   const shell = createDemoShell({ title, course, subtitle, about, galleryHref });
//   const amp = shell.slider({ label, min, max, step, value, fmt, tip });
//   shell.onFrame((t, dt) => { ...draw on shell.ctx (CSS px)... });
//
// Control creators return getter functions; every `tip` feeds both the
// hover tooltip and the ? help sheet (touch-friendly). Simulation time t
// advances only while playing, scaled by the speed control.

const THEME_GLYPH = { dark: '☀︎', light: '☽︎' };

export function createDemoShell({
  title,
  course = '',
  subtitle = '',
  about = '',
  galleryHref = '../../index.html',
  speedControl = true,
} = {}) {
  document.title = `${title} — Vibration Apps`;

  // ---------- markup ----------
  document.body.innerHTML = `
    <div id="app">
      <header id="topbar">
        <div id="brand">
          <span id="brand-name"></span>
          <span id="brand-sub"></span>
        </div>
        <a class="course-chip" href="${galleryHref}" title="All vibration apps"></a>
        <div id="topbar-right">
          <button class="btn" id="btn-help" aria-label="Explain this demo" title="What am I looking at?">?</button>
          <button class="btn" id="btn-full" aria-label="Full screen" title="Full screen — hide all controls">⤢</button>
          <button class="btn" id="btn-theme" aria-label="Toggle light/dark theme" title="Light / dark theme">☀︎</button>
          <button class="btn primary" id="btn-play" title="Space bar toggles play/pause">❚❚ Pause</button>
          <button class="btn" id="btn-panel" aria-label="Toggle controls">☰</button>
        </div>
      </header>
      <main id="stage">
        <div id="plot-wrap"><canvas id="plot"></canvas></div>
        <div id="statusbar"><span class="dim" id="shell-hint">space plays/pauses</span></div>
      </main>
      <aside id="panel" class="panel"></aside>
    </div>
    <button id="btn-exit-full" aria-label="Exit full screen" hidden>✕</button>
    <div id="help-overlay" hidden>
      <div id="help-card" class="panel" role="dialog" aria-modal="true" aria-label="Demo help">
        <header><h3 id="help-title"></h3>
        <button class="btn small" id="btn-help-close" aria-label="Close">✕</button></header>
        <div id="help-body"></div>
      </div>
    </div>`;

  const $ = (id) => document.getElementById(id);
  $('brand-name').textContent = title;
  $('brand-sub').textContent = subtitle;
  $('help-title').textContent = title;
  const chip = document.querySelector('.course-chip');
  if (course) chip.textContent = course;
  else chip.remove();

  const panel = $('panel');
  const canvas = $('plot');
  const ctx = canvas.getContext('2d');
  const tips = []; // [groupTitle, label, tip] for the help sheet

  // ---------- canvas sizing ----------
  const shell = { canvas, ctx, width: 0, height: 0 };

  function resizeCanvas() {
    const rect = $('plot-wrap').getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    shell.width = Math.round(rect.width);
    shell.height = Math.round(rect.height);
    canvas.width = Math.round(shell.width * dpr);
    canvas.height = Math.round(shell.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  new ResizeObserver(resizeCanvas).observe($('plot-wrap'));
  resizeCanvas();

  // ---------- control panel API ----------
  let currentGroup = null;

  function group(titleText) {
    const g = document.createElement('div');
    g.className = 'group';
    if (titleText) {
      const h = document.createElement('h3');
      h.className = 'group-title';
      h.textContent = titleText;
      g.appendChild(h);
    }
    panel.appendChild(g);
    currentGroup = { el: g, title: titleText || '' };
    return currentGroup;
  }

  function row(label, tip) {
    if (!currentGroup) group('Controls');
    const r = document.createElement('div');
    r.className = 'row';
    const l = document.createElement('label');
    l.textContent = label;
    if (tip) {
      l.dataset.tip = tip;
      tips.push([currentGroup.title, label, tip]);
    }
    r.appendChild(l);
    currentGroup.el.appendChild(r);
    return r;
  }

  let uid = 0;

  function slider({ label, min, max, step = 1, value, fmt = (v) => v, tip, onChange }) {
    const r = row(label, tip);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = value;
    input.style.cssText = 'width: 6rem; flex: 1;';
    const ro = document.createElement('span');
    ro.className = 'readout';
    ro.style.cssText = 'min-width: 3.4rem; text-align: right;';
    ro.textContent = fmt(value);
    let v = value;
    input.addEventListener('input', () => {
      v = parseFloat(input.value);
      ro.textContent = fmt(v);
      onChange?.(v);
    });
    r.append(input, ro);
    return () => v;
  }

  function seg({ label, options, value, tip, onChange }) {
    const r = row(label, tip);
    const nav = document.createElement('nav');
    nav.className = 'seg';
    const name = `seg${uid++}`;
    let v = value;
    for (const opt of options) {
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = name;
      input.value = opt.value;
      input.id = `${name}-${opt.value}`;
      input.checked = opt.value === value;
      const l = document.createElement('label');
      l.htmlFor = input.id;
      l.textContent = opt.label;
      input.addEventListener('change', () => {
        if (input.checked) {
          v = opt.value;
          onChange?.(v);
        }
      });
      nav.append(input, l);
    }
    r.appendChild(nav);
    return () => v;
  }

  function toggle({ label, value = false, tip, onChange }) {
    const r = row(label, tip);
    const wrap = document.createElement('span');
    wrap.className = 'switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = value;
    const track = document.createElement('span');
    track.className = 'track';
    wrap.append(input, track);
    let v = value;
    input.addEventListener('change', () => {
      v = input.checked;
      onChange?.(v);
    });
    r.appendChild(wrap);
    return () => v;
  }

  function button({ label, title: btnTitle, onClick }) {
    if (!currentGroup) group('Controls');
    const b = document.createElement('button');
    b.className = 'btn small';
    b.textContent = label;
    if (btnTitle) b.title = btnTitle;
    b.addEventListener('click', onClick);
    const r = document.createElement('div');
    r.className = 'row';
    r.appendChild(b);
    currentGroup.el.appendChild(r);
    return b;
  }

  function finePrint(html) {
    const g = document.createElement('div');
    g.className = 'group';
    const p = document.createElement('p');
    p.className = 'fine-print';
    p.innerHTML = html;
    g.appendChild(p);
    panel.appendChild(g);
  }

  function readout(label) {
    const span = document.createElement('span');
    span.className = 'readout';
    const b = document.createElement('b');
    span.append(`${label} `, b);
    $('statusbar').insertBefore(span, $('shell-hint'));
    return { set: (v) => { b.textContent = v; } };
  }

  // ---------- animation loop ----------
  let playing = true;
  let simTime = 0;
  let speed = 1;
  let frameCb = null;
  let lastNow = performance.now();
  const btnPlay = $('btn-play');

  function setPlaying(on) {
    playing = on;
    btnPlay.textContent = on ? '❚❚ Pause' : '▶ Play';
    document.body.classList.toggle('running', on);
  }

  btnPlay.addEventListener('click', () => setPlaying(!playing));
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(document.activeElement?.tagName)) {
      e.preventDefault();
      setPlaying(!playing);
    }
    if (e.key === 'Escape') {
      $('help-overlay').hidden = true;
      if (document.body.classList.contains('fullview')) setFullview(false);
    }
  });

  function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min((now - lastNow) / 1000, 0.1);
    lastNow = now;
    if (shell.width < 10 || shell.height < 10) return;
    if (playing) simTime += dt * speed;
    frameCb?.(simTime, playing ? dt * speed : 0);
  }

  requestAnimationFrame(loop);

  // ---------- top-bar extras ----------
  if (speedControl) {
    const wrap = document.createElement('nav');
    wrap.className = 'seg';
    wrap.title = 'Animation speed';
    const name = 'shellspeed';
    for (const [v, lab] of [[0.25, '¼×'], [1, '1×'], [3, '3×']]) {
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = name;
      input.id = `${name}-${v}`;
      input.checked = v === 1;
      const l = document.createElement('label');
      l.htmlFor = input.id;
      l.textContent = lab;
      input.addEventListener('change', () => { speed = v; });
      wrap.append(input, l);
    }
    $('topbar-right').insertBefore(wrap, $('btn-help'));
  }

  const btnTheme = $('btn-theme');

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('vibapps-theme', theme); } catch { /* private mode */ }
    btnTheme.textContent = THEME_GLYPH[theme];
    window.dispatchEvent(new Event('themechange'));
  }

  btnTheme.textContent = THEME_GLYPH[document.documentElement.dataset.theme || 'dark'];
  btnTheme.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });

  const btnExitFull = $('btn-exit-full');

  function setFullview(on) {
    document.body.classList.toggle('fullview', on);
    btnExitFull.hidden = !on;
    if (on) document.documentElement.requestFullscreen?.().catch(() => { /* iOS: CSS-only */ });
    else if (document.fullscreenElement) document.exitFullscreen?.();
  }

  $('btn-full').addEventListener('click', () => setFullview(true));
  btnExitFull.addEventListener('click', () => setFullview(false));
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) setFullview(false);
  });

  $('btn-panel').addEventListener('click', () => document.body.classList.toggle('panel-open'));
  $('plot-wrap').addEventListener('pointerdown', () => document.body.classList.remove('panel-open'));

  // ---------- help sheet ----------
  const helpOverlay = $('help-overlay');
  $('btn-help').addEventListener('click', () => {
    const body = $('help-body');
    body.innerHTML = '';
    if (about) {
      const p = document.createElement('p');
      p.className = 'about';
      p.textContent = about;
      body.appendChild(p);
    }
    let lastGroup = null;
    let dl = null;
    for (const [groupTitle, label, tip] of tips) {
      if (groupTitle !== lastGroup) {
        const h = document.createElement('h4');
        h.textContent = groupTitle || 'Controls';
        body.appendChild(h);
        dl = document.createElement('dl');
        body.appendChild(dl);
        lastGroup = groupTitle;
      }
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = tip;
      dl.append(dt, dd);
    }
    helpOverlay.hidden = false;
  });
  $('btn-help-close').addEventListener('click', () => { helpOverlay.hidden = true; });
  helpOverlay.addEventListener('click', (e) => {
    if (e.target === helpOverlay) helpOverlay.hidden = true;
  });

  // ---------- public API ----------
  shell.group = group;
  shell.slider = slider;
  shell.seg = seg;
  shell.toggle = toggle;
  shell.button = button;
  shell.finePrint = finePrint;
  shell.readout = readout;
  shell.onFrame = (cb) => { frameCb = cb; };
  shell.setPlaying = setPlaying;
  shell.resetTime = () => { simTime = 0; };
  shell.isPlaying = () => playing;
  setPlaying(true);
  return shell;
}
