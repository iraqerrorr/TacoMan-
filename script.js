'use strict';

/* ==========================================================================
   Taco Profile — script
   Plain JavaScript, no dependencies (GSAP was replaced by CSS + Web Animations).
   Sections: config · helpers · video (4K) · audio · effects · cursor ·
             typewriter · panels · themes · wiring
   ========================================================================== */

/* ---------- Config: edit these ------------------------------------------- */
const CONFIG = {
  startText: 'click to enter...',
  name: 'iraqerror',
  bio: ['MEXICAN', '"I LOVE YOU"'],
  visitorBase: 157,
  defaultTheme: 'home',

  // Approximate bitrate of your 2160p files. Only used to ask the browser
  // "can this device decode 4K at this bitrate smoothly?"
  video4kBitrate: 12_000_000,

  // video: path WITHOUT extension. The page looks for, in order:
  //   <video>_2160p.mp4  →  <video>_1080p.mp4  →  <video>.<legacyExt|mp4>
  // (tools/encode-videos.sh creates the first two from your originals.)
  themes: {
    home:   { video: 'assets/background',        audio: 'background-music' },
    hacker: { video: 'assets/hacker_background', audio: 'hacker-music', fx: 'matrix', results: true },
    rain:   { video: 'assets/rain_background',   audio: 'rain-music',   fx: 'snow', fxOverPanel: true, legacyExt: 'mov' },
    anime:  { video: 'assets/anime_background',  audio: 'anime-music' },
    car:    { video: 'assets/car_background',    audio: 'car-music' },
  },
};

/* ---------- Helpers ------------------------------------------------------ */
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const reduced     = matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem('taco.' + key); return v === null ? fallback : v; }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('taco.' + key, String(value)); } catch { /* private mode */ }
  },
};

const THEME_KEYS = Object.keys(CONFIG.themes);
let currentTheme = null;
let started = false;

const el = {
  body: document.body,
  startScreen: $('#start-screen'),
  startText: $('#start-text'),
  profileName: $('#profile-name'),
  profileBio: $('#profile-bio'),
  visitorCount: $('#visitor-count'),
  resultsWrap: $('#results-button-container'),
  resultsBtn: $('#results-theme'),
  resultsHint: $('#results-hint'),
  muteBtn: $('#mute-btn'),
  volumeSlider: $('#volume-slider'),
  opacitySlider: $('#transparency-slider'),
  toast: $('#toast'),
  glitch: $('.glitch-overlay'),
  picture: $('.profile-picture'),
  pictureWrap: $('.profile-container'),
  themeBtns: $$('.theme-button'),
};

let toastTimer = 0;
function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.add('is-shown');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('is-shown'), 5000);
}

/* ==========================================================================
   VIDEO — 4K-aware background
   ========================================================================== */

/** Ask the browser whether it can decode 3840×2160 H.264 smoothly. */
async function canDecode4K() {
  const mc = navigator.mediaCapabilities;
  if (!mc || !mc.decodingInfo) return true;           // can't tell → try it; errors fall back
  try {
    const info = await mc.decodingInfo({
      type: 'file',
      video: {
        contentType: 'video/mp4; codecs="avc1.640034"', // High profile, level 5.2
        width: 3840,
        height: 2160,
        bitrate: CONFIG.video4kBitrate,
        framerate: 30,
      },
    });
    return info.supported && info.smooth;
  } catch {
    return true;
  }
}

const Quality = {
  mode: 'auto',                                       // always automatic (no manual control)
  autoCap: 2160,                                      // Auto never goes above this

  cap() { return this.mode === 'auto' ? this.autoCap : Number(this.mode); },

  /** Decide what "Auto" means on this device. */
  async detect() {
    if (!['auto', '2160', '1080'].includes(this.mode)) this.mode = 'auto';

    const conn = navigator.connection || {};
    const longEdge = Math.max(screen.width, screen.height) * (window.devicePixelRatio || 1);
    const phone = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600;

    // Only trust explicit signals here. navigator.connection.downlink is a rough,
    // capped estimate that often under-reports on fast desktops, so a slow link is
    // caught later by watching real playback (see VideoStage._monitor).
    const savingData = conn.saveData || ['slow-2g', '2g', '3g'].includes(conn.effectiveType);
    // A 1080p/1440p display gains nothing from a 4K file, so don't spend the bandwidth.
    if (savingData || phone || longEdge < 2560) { this.autoCap = 1080; return; }

    const decodes = await Promise.race([canDecode4K(), sleep(1500).then(() => true)]);
    this.autoCap = decodes ? 2160 : 1080;
  },
};

/** Candidate files for a theme, best first, filtered by the quality cap. */
function ladder(theme, cap) {
  const legacy = `${theme.video}.${theme.legacyExt || 'mp4'}`;
  return [
    { height: 2160, src: `${theme.video}_2160p.mp4` },
    { height: 1080, src: `${theme.video}_1080p.mp4` },
    { height: 0,    src: legacy },                    // your original file, whatever it is
  ].filter(c => c.height <= cap);
}

class VideoStage {
  constructor(layers, hooks = {}) {
    this.layers = layers;
    this.hooks = hooks;
    this.active = -1;
    this.token = 0;
    this.currentSrc = '';
    this.failed = new Set();       // files that errored (404, bad codec) this session
    this.monitorId = 0;
    layers.forEach(layer => { layer._gen = 0; });
  }

  get video() { return this.active >= 0 ? this.layers[this.active] : null; }

  /**
   * Try each candidate until one is ready to play, then cross-fade to it.
   * Resolves 'ok' | 'failed' | 'superseded' (a newer show() took over).
   */
  async show(candidates) {
    const token = ++this.token;
    const list = candidates.filter(c => !this.failed.has(c.src));

    for (let i = 0; i < list.length; i++) {
      const cand = list[i];
      if (this.video && cand.src === this.currentSrc) return 'ok';   // already playing it

      const idx = this.active === 0 ? 1 : 0;
      const isLast = i === list.length - 1;
      // Give a big file ~10s to get going before trying a lighter one;
      // the final option gets as long as it needs.
      const result = await this._load(this.layers[idx], cand.src, isLast ? 60000 : 10000);

      if (token !== this.token) return 'superseded';
      if (result === 'ok') { this._activate(idx, cand); return 'ok'; }
      if (result === 'error') this.failed.add(cand.src);
      console.info(`[video] ${cand.src}: ${result}${isLast ? '' : ', trying next'}`);
    }
    return 'failed';
  }

  _load(video, src, timeoutMs) {
    return new Promise(resolve => {
      let timer = 0;
      const done = result => {
        clearTimeout(timer);
        video.removeEventListener('canplay', onReady);
        video.removeEventListener('error', onError);
        resolve(result);
      };
      const onReady = () => done('ok');
      const onError = () => done('error');
      timer = setTimeout(() => done('timeout'), timeoutMs);

      video._gen++;
      video.addEventListener('canplay', onReady);
      video.addEventListener('error', onError);
      video.preload = 'auto';
      video.src = src;
    });
  }

  _activate(idx, cand) {
    const next = this.layers[idx];
    const prev = this.video;
    this.active = idx;
    this.currentSrc = cand.src;

    next.classList.add('is-active');
    next.play().catch(() => { /* autoplay blocked — muted video normally isn't */ });

    if (prev && prev !== next) {
      prev.classList.remove('is-active');
      const gen = ++prev._gen;
      // After the fade, release the old decoder (two 4K decoders is a lot of memory).
      setTimeout(() => {
        if (prev._gen === gen && !prev.classList.contains('is-active')) {
          prev.pause();
          prev.removeAttribute('src');
          prev.load();
        }
      }, 800);
    }

    console.info(`[video] playing ${cand.src} (${next.videoWidth}×${next.videoHeight})`);
    this._monitor(next);
    if (this.hooks.onActive) this.hooks.onActive(next, cand);
  }

  /**
   * Watch real playback and tell the app if it's struggling:
   *   'frames'    — a quarter or more of frames dropped, two checks in a row (decoder too slow)
   *   'buffering' — 3+ times the video ran out of data within 20s (connection too slow)
   */
  _monitor(video) {
    clearInterval(this.monitorId);
    if (this._onWaiting) this._waitingTarget.removeEventListener('waiting', this._onWaiting);

    const report = reason => {
      clearInterval(this.monitorId);
      video.removeEventListener('waiting', this._onWaiting);
      if (this.hooks.onStruggle) this.hooks.onStruggle(reason);
    };

    const stalls = [];
    const armedAt = performance.now() + 3000;       // ignore the initial buffering
    this._waitingTarget = video;
    this._onWaiting = () => {
      const now = performance.now();
      if (now < armedAt || video.readyState >= 3) return;
      stalls.push(now);
      while (stalls.length && now - stalls[0] > 20000) stalls.shift();
      if (stalls.length >= 3) report('buffering');
    };
    video.addEventListener('waiting', this._onWaiting);

    if (!video.getVideoPlaybackQuality) return;
    let last = video.getVideoPlaybackQuality();
    let strikes = 0;
    this.monitorId = setInterval(() => {
      if (document.hidden || video.paused || video.ended) return;
      const q = video.getVideoPlaybackQuality();
      const total = q.totalVideoFrames - last.totalVideoFrames;
      const dropped = q.droppedVideoFrames - last.droppedVideoFrames;
      last = q;
      strikes = (total > 20 && dropped / total > 0.25) ? strikes + 1 : 0;
      if (strikes >= 2) report('frames');
    }, 3000);
  }

  pause()  { if (this.video) this.video.pause(); }
  resume() { if (this.video) this.video.play().catch(() => {}); }
}

function qualityLabel(height) {
  if (!height) return '';
  return height >= 2000 ? '4K' : `${height}p`;
}

function updateQualityButton() { /* quality button removed; kept so callers stay simple */ }

const stage = new VideoStage($$('.bg-video'), {
  onActive: updateQualityButton,
  onStruggle() {
    // A stall can come from a slow decoder or a slow connection. Step down quietly.
    if (Quality.mode === 'auto' && Quality.autoCap > 1080) {
      console.info('[video] 4K not playing smoothly, switching to 1080p');
      Quality.autoCap = 1080;
      loadThemeVideo(currentTheme);
    }
  },
});

async function loadThemeVideo(key) {
  const theme = CONFIG.themes[key];
  const btn = el.themeBtns.find(b => b.dataset.theme === key);
  if (btn) btn.classList.add('is-loading');

  const status = await stage.show(ladder(theme, Quality.cap()));

  if (btn) btn.classList.remove('is-loading');
  if (status === 'superseded' || key !== currentTheme) return status;

  if (status === 'failed') {
    const h264 = document.createElement('video').canPlayType('video/mp4; codecs="avc1.640034"');
    toast(h264
      ? `Couldn't load this theme's video. Check the files in assets/ (see README).`
      : `This browser can't play H.264 video, so the background is off.`);
  }
  updateQualityButton();
  return status;
}

/* ==========================================================================
   AUDIO
   ========================================================================== */
const Sound = {
  tracks: Object.fromEntries($$('audio').map(a => [a.id, a])),
  current: null,
  enabled: false,                                     // true after the first click
  master: Math.min(1, Math.max(0, Number(store.get('volume', 0.3)))),
  muted: false,

  select(id) {
    const next = this.tracks[id];
    if (!next || next === this.current) return;
    const prev = this.current;
    this.current = next;
    if (prev) this._fadeOut(prev);
    if (this.enabled) this._fadeIn(next);
  },

  enable() {
    this.enabled = true;
    if (this.current) this._fadeIn(this.current);
  },

  setMaster(value) {
    this.master = value;
    this.muted = false;
    Object.values(this.tracks).forEach(a => { a.muted = false; });
    if (this.current) {
      clearInterval(this.current._fade);
      this.current.volume = value;
    }
  },

  setMuted(flag) {
    this.muted = flag;
    Object.values(this.tracks).forEach(a => { a.muted = flag; });
  },

  _fade(audio, to, ms, done) {
    clearInterval(audio._fade);
    const from = audio.volume;
    const t0 = performance.now();
    audio._fade = setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      audio.volume = Math.min(1, Math.max(0, from + (to - from) * k));
      if (k >= 1) { clearInterval(audio._fade); if (done) done(); }
    }, 30);
  },

  _fadeIn(audio) {
    audio.muted = this.muted;
    audio.volume = 0;
    audio.play().catch(err => console.warn(`[audio] ${audio.id}:`, err.message));
    this._fade(audio, this.master, 600);
  },

  _fadeOut(audio) {
    this._fade(audio, 0, 400, () => { audio.pause(); audio.currentTime = 0; });
  },
};

function syncMuteButton() {
  const off = Sound.muted || Sound.master === 0;
  el.muteBtn.setAttribute('aria-pressed', String(off));
  el.muteBtn.setAttribute('aria-label', off ? 'Unmute music' : 'Mute music');
}

/* ==========================================================================
   EFFECTS — matrix rain (hacker) and snow (rain)
   ========================================================================== */
class CanvasFX {
  constructor(canvas, intervalMs) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.interval = intervalMs;
    this.running = false;
    this.last = 0;
    this.raf = 0;
    this._loop = this._loop.bind(this);
    addEventListener('resize', () => { if (this.running) this._resize(); });
  }

  start(overPanel = false) {
    this.canvas.classList.toggle('over-panel', overPanel);
    if (this.running) return;
    this.canvas.hidden = false;
    this._resize();
    this.running = true;
    this.raf = requestAnimationFrame(this._loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.canvas.hidden = true;
  }

  _resize() {
    this.w = this.canvas.width = innerWidth;
    this.h = this.canvas.height = innerHeight;
    this.setup();
  }

  _loop(t) {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this._loop);
    if (document.hidden || t - this.last < this.interval) return;
    this.last = t;
    this.frame();
  }
}

class MatrixRain extends CanvasFX {
  constructor(canvas) {
    super(canvas, 50);
    this.glyphs = Array.from('アイウエオカキクケコサシスセソタチツテトナニヌネノ0123456789');
  }
  setup() {
    this.size = 16;
    this.drops = Array.from({ length: Math.ceil(this.w / this.size) }, () => Math.random() * -50);
    this.color = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#22C55E';
  }
  frame() {
    const { ctx, size } = this;
    // Fade old glyphs toward transparent (so the video shows through).
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.globalCompositeOperation = 'source-over';
    ctx.font = `${size}px monospace`;
    ctx.fillStyle = this.color;
    for (let i = 0; i < this.drops.length; i++) {
      const y = this.drops[i] * size;
      ctx.fillText(this.glyphs[(Math.random() * this.glyphs.length) | 0], i * size, y);
      if (y > this.h && Math.random() > 0.975) this.drops[i] = 0;
      this.drops[i]++;
    }
  }
}

class Snow extends CanvasFX {
  constructor(canvas) { super(canvas, 0); }
  _flake(anywhere) {
    return {
      x: Math.random() * this.w,
      y: anywhere ? Math.random() * this.h : -10,
      r: Math.random() * 2.2 + 0.8,
      vy: Math.random() * 1 + 0.6,
      phase: Math.random() * Math.PI * 2,
      sway: Math.random() * 0.6 + 0.2,
    };
  }
  setup() {
    const count = Math.min(220, Math.round((this.w * this.h) / 9000));
    this.flakes = Array.from({ length: count }, () => this._flake(true));
  }
  frame() {
    const { ctx } = this;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    for (const f of this.flakes) {
      f.phase += 0.02;
      f.x += Math.sin(f.phase) * f.sway;
      f.y += f.vy;
      if (f.y > this.h + 5) Object.assign(f, this._flake(false));
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

const FX = {
  matrix: new MatrixRain($('#hacker-overlay')),
  snow: new Snow($('#snow-overlay')),
  active: null,
  set(name, overPanel = false) {
    if (this.active && this.active !== name) this[this.active].stop();
    this.active = reduced ? null : (name || null);
    if (this.active) this[this.active].start(overPanel);
  },
};

/* ==========================================================================
   CURSOR + TRAIL (mouse/pen only)
   ========================================================================== */
const INTERACTIVE = 'a, button, input, [role="button"], [tabindex], .profile-picture';

function initCursor() {
  const cursor = $('.custom-cursor');
  if (!finePointer) { cursor.remove(); return; }

  // Only hide the native pointer once the custom image has really loaded.
  const probe = new Image();
  probe.onload = () => el.body.classList.add('has-cursor');
  probe.src = 'assets/custom_cursor.png';

  document.addEventListener('pointermove', e => {
    if (e.pointerType === 'touch') return;
    cursor.style.translate = `${e.clientX}px ${e.clientY}px`;
    cursor.classList.add('is-visible');
    cursor.classList.toggle('is-hover', Boolean(e.target.closest && e.target.closest(INTERACTIVE)));
  }, { passive: true });
  document.addEventListener('pointerdown', () => cursor.classList.add('is-down'));
  document.addEventListener('pointerup', () => cursor.classList.remove('is-down'));
  document.documentElement.addEventListener('mouseleave', () => cursor.classList.remove('is-visible'));
}

/** Dots that chase the pointer, each following the one before it. */
class CursorTrail {
  constructor({ length = 10, size = 8, speed = 0.2 } = {}) {
    this.speed = speed;
    this.target = { x: -100, y: -100 };
    this.seeded = false;
    this.running = false;
    this.tick = this.tick.bind(this);

    this.dots = Array.from({ length }, (_, i) => {
      const node = document.createElement('div');
      const s = Math.max(2, size * (1 - (i / length) * 0.7));
      node.className = 'cursor-trail-dot';
      node.style.width = node.style.height = `${s}px`;
      node.style.opacity = String(0.8 * (1 - i / length));
      node.setAttribute('aria-hidden', 'true');
      document.body.appendChild(node);
      return { node, x: -100, y: -100 };
    });

    document.addEventListener('pointermove', e => {
      if (e.pointerType === 'touch') return;
      this.target.x = e.clientX;
      this.target.y = e.clientY;
      if (!this.seeded) {                           // start under the pointer, not off-screen
        this.dots.forEach(d => { d.x = e.clientX; d.y = e.clientY; });
        this.seeded = true;
      }
      if (!this.running) { this.running = true; requestAnimationFrame(this.tick); }
    }, { passive: true });
  }

  tick() {
    let px = this.target.x;
    let py = this.target.y;
    let moving = false;
    for (const d of this.dots) {
      d.x += (px - d.x) * this.speed;
      d.y += (py - d.y) * this.speed;
      if (Math.abs(px - d.x) > 0.1 || Math.abs(py - d.y) > 0.1) moving = true;
      d.node.style.transform = `translate3d(${d.x}px, ${d.y}px, 0) translate(-50%, -50%)`;
      px = d.x;
      py = d.y;
    }
    if (moving) requestAnimationFrame(this.tick);
    else this.running = false;                      // idle = zero CPU
  }
}

/* ==========================================================================
   TYPEWRITER
   ========================================================================== */
function typewriter(host, phrases, { typeMs = 150, eraseMs = 75, holdMs = 2000, loop = true, glitch = false } = {}) {
  const out = $('.typed', host) || host;

  const maybeGlitch = () => {
    if (glitch && Math.random() < 0.1) {
      host.classList.add('glitch');
      setTimeout(() => host.classList.remove('glitch'), 200);
    }
  };

  (async () => {
    for (let i = 0; ; i++) {
      // Array.from keeps characters like 𝑇 (two UTF-16 units) intact.
      const chars = Array.from(phrases[i % phrases.length]);
      for (let n = 1; n <= chars.length; n++) {
        out.textContent = chars.slice(0, n).join('');
        maybeGlitch();
        await sleep(typeMs);
      }
      if (!loop) return;
      await sleep(holdMs);
      for (let n = chars.length - 1; n >= 0; n--) {
        out.textContent = chars.slice(0, n).join('');
        maybeGlitch();
        await sleep(eraseMs);
      }
      await sleep(typeMs);
    }
  })();
}

/* ==========================================================================
   PANELS (profile ⇄ skills) — Web Animations on the `translate` property so
   they never clash with the tilt (`transform`).
   ========================================================================== */
async function play(node, frames, ms, easing) {
  const animation = node.animate(frames, { duration: reduced ? 1 : ms, easing, fill: 'forwards' });
  try { await animation.finished; } catch { /* cancelled */ }
  return animation;
}

const Panels = {
  profile: $('#profile-block'),
  skills: $('#skills-block'),
  bars: $$('.skill-bar'),
  current: 'profile',
  revealed: false,
  busy: false,
  epoch: 0,                                         // bumps to cancel in-flight transitions

  async reveal() {
    this.revealed = true;
    const my = ++this.epoch;
    this.busy = true;
    this.profile.hidden = false;
    const a = await play(this.profile,
      [{ opacity: 0, translate: '0 -50px' }, { opacity: 1, translate: '0 0' }],
      1000, 'cubic-bezier(.22, 1, .36, 1)');
    a.cancel();
    if (my === this.epoch) this.busy = false;
  },

  /** Jump straight to a panel (used when the theme changes). */
  force(name) {
    this.epoch++;
    this.busy = false;
    this.current = name;
    for (const key of ['profile', 'skills']) {
      this[key].getAnimations().forEach(a => a.cancel());
      this[key].hidden = !(this.revealed && key === name);
    }
    if (name !== 'skills') this._resetBars();
    el.resultsHint.hidden = true;
    el.resultsBtn.setAttribute('aria-pressed', 'false');
  },

  async go(name) {
    if (this.busy || !this.revealed || name === this.current) return;
    const my = ++this.epoch;
    this.busy = true;
    const from = this[this.current];
    const to = this[name];
    const dir = name === 'skills' ? 1 : -1;

    el.resultsHint.hidden = name !== 'skills';
    el.resultsBtn.setAttribute('aria-pressed', String(name === 'skills'));

    let a = await play(from,
      [{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: `${-100 * dir}px 0` }], 500, 'ease-in');
    if (my !== this.epoch) return;
    from.hidden = true;
    a.cancel();

    to.hidden = false;
    void to.offsetWidth;                            // make sure bars start from 0 before animating
    this.current = name;
    if (name === 'skills') this._fillBars(); else this._resetBars();

    a = await play(to,
      [{ opacity: 0, translate: `${100 * dir}px 0` }, { opacity: 1, translate: '0 0' }], 500, 'ease-out');
    if (my !== this.epoch) return;
    a.cancel();
    this.busy = false;
  },

  _fillBars()  { this.bars.forEach(b => { b.style.width = `${b.dataset.level}%`; }); },
  _resetBars() { this.bars.forEach(b => { b.style.width = ''; }); },
};

/** Gentle 3D tilt toward the pointer (mouse only — never blocks touch scrolling). */
function enableTilt(panel) {
  if (reduced || !finePointer) return;
  let frame = 0;
  let evt = null;
  panel.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse') return;
    evt = e;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const r = panel.getBoundingClientRect();
      const x = (evt.clientX - (r.left + r.width / 2)) / r.width;
      const y = (evt.clientY - (r.top + r.height / 2)) / r.height;
      panel.style.setProperty('--rx', `${(y * 15).toFixed(2)}deg`);
      panel.style.setProperty('--ry', `${(-x * 15).toFixed(2)}deg`);
    });
  });
  panel.addEventListener('pointerleave', () => {
    cancelAnimationFrame(frame);
    frame = 0;
    panel.style.setProperty('--rx', '0deg');
    panel.style.setProperty('--ry', '0deg');
  });
}

/* ==========================================================================
   THEMES
   ========================================================================== */
function setTheme(key, { initial = false } = {}) {
  const theme = CONFIG.themes[key];
  if (!theme) return;
  currentTheme = key;
  store.set('theme', key);

  el.body.classList.remove(...THEME_KEYS.map(k => `${k}-theme`));
  el.body.classList.add(`${key}-theme`);
  el.themeBtns.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.theme === key)));

  el.resultsWrap.hidden = !theme.results;
  if (!theme.results && Panels.current === 'skills') Panels.force('profile');

  FX.set(theme.fx, theme.fxOverPanel);

  // Start loading the video; switch the music when it's ready (or after 2.5s
  // at most, so a big 4K file never leaves the old track playing forever).
  const loading = loadThemeVideo(key);
  Promise.race([loading, sleep(initial ? 0 : 2500)]).then(() => {
    if (key === currentTheme) Sound.select(theme.audio);
  });
}

/* ==========================================================================
   VISITOR COUNTER  (per-browser; see README)
   ========================================================================== */
function initVisitorCounter() {
  let total;
  try {
    total = parseInt(localStorage.getItem('totalVisitorCount'), 10);
    if (!Number.isFinite(total)) total = CONFIG.visitorBase;
    if (!localStorage.getItem('hasVisited')) {
      total++;
      localStorage.setItem('hasVisited', 'true');
    }
    localStorage.setItem('totalVisitorCount', String(total));
  } catch {
    total = CONFIG.visitorBase + 1;
  }
  el.visitorCount.textContent = total.toLocaleString();
}

/* ==========================================================================
   WIRING
   ========================================================================== */
function start() {
  started = true;
  el.startScreen.classList.add('is-leaving');
  setTimeout(() => { el.startScreen.hidden = true; }, 500);

  Sound.enable();
  typewriter(el.profileName, [CONFIG.name], { typeMs: 300, eraseMs: 150, holdMs: 10000, glitch: true });
  typewriter(el.profileBio, CONFIG.bio, { typeMs: 150, eraseMs: 75, holdMs: 2000, glitch: true });
  Panels.reveal();
  if (finePointer && !reduced) new CursorTrail({ length: 10, size: 8, speed: 0.2 });
}

function init() {
  // Text from config
  el.profileName.setAttribute('aria-label', CONFIG.name);
  el.profileName.dataset.text = `${CONFIG.name}|`;
  $('.typed', el.profileName).textContent = '';
  $('.typed', el.profileBio).textContent = '';
  const srBio = document.createElement('span');
  srBio.className = 'sr-only';
  srBio.textContent = CONFIG.bio.join('. ');
  el.profileBio.prepend(srBio);

  initVisitorCounter();
  initCursor();

  // Start screen: type the intro once, then wait for a click / Enter.
  el.startText.classList.add('typed');
  typewriter(el.startScreen, [CONFIG.startText], { typeMs: 100, loop: false });
  el.startScreen.addEventListener('click', start, { once: true });
  el.startScreen.focus();

  // Theme buttons + number keys
  el.themeBtns.forEach(btn => btn.addEventListener('click', () => setTheme(btn.dataset.theme)));
  addEventListener('keydown', e => {
    if (!started || e.ctrlKey || e.metaKey || e.altKey) return;
    const n = Number(e.key);
    if (n >= 1 && n <= THEME_KEYS.length) setTheme(THEME_KEYS[n - 1]);
    else if (e.key === 'm' || e.key === 'M') el.muteBtn.click();
  });

  // Volume + mute
  el.volumeSlider.value = Sound.master;
  el.volumeSlider.addEventListener('input', () => {
    Sound.setMaster(Number(el.volumeSlider.value));
    syncMuteButton();
  });
  el.volumeSlider.addEventListener('change', () => store.set('volume', el.volumeSlider.value));
  el.muteBtn.addEventListener('click', () => {
    if (Sound.master === 0) {                       // slider at zero: "unmute" means bring it back up
      el.volumeSlider.value = 0.3;
      Sound.setMaster(0.3);
    } else {
      Sound.setMuted(!Sound.muted);
    }
    syncMuteButton();
  });
  syncMuteButton();

  // Panel opacity
  const applyOpacity = v => document.documentElement.style.setProperty('--panel-alpha', v);
  el.opacitySlider.value = store.get('opacity', el.opacitySlider.value);
  applyOpacity(el.opacitySlider.value);
  el.opacitySlider.addEventListener('input', () => applyOpacity(el.opacitySlider.value));
  el.opacitySlider.addEventListener('change', () => store.set('opacity', el.opacitySlider.value));

  // Skills ⇄ profile
  el.resultsBtn.addEventListener('click', () => Panels.go(Panels.current === 'skills' ? 'profile' : 'skills'));

  // Panel tilt
  enableTilt(Panels.profile);
  enableTilt(Panels.skills);

  // Profile picture: glitch flash on hover, fast orbit on click
  el.picture.addEventListener('pointerenter', () => {
    if (reduced) return;
    el.glitch.classList.remove('is-on');
    void el.glitch.offsetWidth;
    el.glitch.classList.add('is-on');
  });
  el.glitch.addEventListener('animationend', () => el.glitch.classList.remove('is-on'));
  el.picture.addEventListener('click', () => {
    el.pictureWrap.classList.add('fast-orbit');
    setTimeout(() => el.pictureWrap.classList.remove('fast-orbit'), 500);
  });

  // Save battery: pause the video while the tab is hidden
  document.addEventListener('visibilitychange', () => (document.hidden ? stage.pause() : stage.resume()));

  // Go
  Quality.detect().then(() => {
    updateQualityButton();
    const saved = store.get('theme', CONFIG.defaultTheme);
    setTheme(THEME_KEYS.includes(saved) ? saved : CONFIG.defaultTheme, { initial: true });
  });
}

init();
