// ==========================================================
// Bloom orb — the living, voice-reactive centrepiece.
// Layered petal blobs whose outline is a sum of slow sine
// harmonics; amplitude follows the microphone level.
// Shared by the app window, the overlay pill and the web client.
// ==========================================================
(function (root) {
  const TAU = Math.PI * 2;
  const DEFAULT_PALETTE = ['#4a9dff', '#8f6bff', '#ff5fa2', '#ffb347'];

  function createBloomOrb(canvas, opts = {}) {
    const ctx = canvas?.getContext?.('2d');
    // No 2D context (tests, GPU failure): return an inert orb
    if (!ctx) return { setLevel() {}, setState(s) { this.state = s; }, setPalette() {}, state: 'idle', destroy() {} };
    const reduceMotion = root.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let palette = opts.palette || DEFAULT_PALETTE;
    let state = 'idle';
    let level = 0;           // smoothed input level 0..1
    let target = 0;          // latest raw level
    let energy = 0;          // eased deformation energy
    let clock = 0;           // motion clock; runs slower while processing
    let procMix = 0;         // 0..1 blend into the processing look
    let errorMix = 0;
    let ripples = [];        // { born }
    let raf = 0;
    let last = performance.now();
    let t0 = last;
    let destroyed = false;
    const seeds = Array.from({ length: 5 }, (_, i) => ({
      phase: Math.random() * TAU,
      speed: 0.18 + i * 0.07,
      lobes: [3, 5, 4, 6, 7][i],
      rot: (i / 5) * TAU
    }));
    const scale = opts.scale || 0.29;  // orb radius as a fraction of canvas size

    function resize() {
      const dpr = Math.min(root.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth || opts.width || 300;
      const h = canvas.clientHeight || opts.height || w;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      return { w: canvas.width, h: canvas.height, dpr };
    }

    // While processing, each petal layer slowly blends between two petal
    // counts, so the bloom changes shape instead of spinning.
    function blobPath(cx, cy, r, seed, t, amp, morph) {
      const steps = 96;
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * TAU;
        const tt = t * seed.speed * (1 + energy * 2.2);
        const main = Math.sin(a * seed.lobes + seed.phase + tt);
        const alt = Math.sin(a * (seed.lobes + 2) + seed.phase * 1.7 - tt * 0.6);
        const wob = ((1 - morph) * main + morph * alt) * amp
          + Math.sin(a * (seed.lobes - 1) - tt * 0.7 + seed.rot) * amp * 0.55;
        const rr = r * (1 + wob);
        const x = cx + Math.cos(a + seed.rot + t * 0.04) * rr;
        const y = cy + Math.sin(a + seed.rot + t * 0.04) * rr;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
    }

    function frame(now) {
      if (destroyed) return;
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const wall = reduceMotion ? 0 : (now - t0) / 1000;
      const { w, h, dpr } = resize();
      const cx = w / 2;
      const cy = h / 2;
      const base = Math.min(w, h) * scale;

      // Ease everything so state changes glide instead of snapping
      level += ((state === 'listening' ? target : 0) - level) * Math.min(1, dt * (target > level ? 18 : 7));
      procMix += ((state === 'processing' ? 1 : 0) - procMix) * Math.min(1, dt * 3);
      // Processing: a slow, deep inhale and exhale of the petal amplitude
      const wantEnergy = state === 'listening' ? 0.35 + level * 1.4 : state === 'processing' ? 0.55 + 0.3 * Math.sin(wall * 0.9) : 0.12;
      energy += (wantEnergy - energy) * Math.min(1, dt * 3);
      errorMix += ((state === 'error' ? 1 : 0) - errorMix) * Math.min(1, dt * 6);
      if (!reduceMotion) clock += dt * (1 - procMix * 0.7);
      const t = clock;

      ctx.clearRect(0, 0, w, h);
      const breathe = 1 + Math.sin(wall * 1.3) * 0.018 * (1 - level) + Math.sin(wall * 0.9) * 0.03 * procMix;
      const r = base * breathe * (1 + level * 0.16) * (1 - procMix * 0.06);
      const amp = 0.018 + energy * 0.085;
      const shake = errorMix > 0.02 ? Math.sin(wall * 60) * errorMix * base * 0.04 : 0;

      // Soft outer glow
      const edge = Math.min(w, h) / 2;
      const glow = ctx.createRadialGradient(cx, cy, r * 0.4, cx, cy, Math.min(r * 2.1, edge));
      glow.addColorStop(0, hexA(palette[1], 0.34 + level * 0.25));
      glow.addColorStop(0.5, hexA(palette[2], 0.1 + level * 0.12));
      glow.addColorStop(1, hexA(palette[2], 0));
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);

      // Ripples released on "done"
      ripples = ripples.filter((rp) => now - rp.born < 1400);
      for (const rp of ripples) {
        const k = (now - rp.born) / 1400;
        ctx.beginPath();
        ctx.arc(cx, cy, r * (1 + k * 0.9), 0, TAU);
        ctx.strokeStyle = hexA(palette[rp.i % palette.length], (1 - k) * 0.55);
        ctx.lineWidth = 2 * dpr * (1 - k) + 0.5;
        ctx.stroke();
      }

      // Petal layers
      ctx.save();
      ctx.translate(shake, 0);
      // 'screen' keeps the hues; 'lighter' blew the overlap out to white
      ctx.globalCompositeOperation = 'screen';
      seeds.forEach((seed, i) => {
        const col = palette[i % palette.length];
        const col2 = palette[(i + 1) % palette.length];
        const off = r * 0.12 * (1 + level);
        const ox = cx + Math.cos(t * 0.3 + seed.rot) * off;
        const oy = cy + Math.sin(t * 0.26 + seed.rot) * off;
        const g = ctx.createRadialGradient(ox - r * 0.3, oy - r * 0.35, r * 0.05, ox, oy, r * 1.15);
        g.addColorStop(0, hexA(col, 0.6 + level * 0.25));
        g.addColorStop(0.6, hexA(col2, 0.42));
        g.addColorStop(1, hexA(col2, 0.04));
        ctx.fillStyle = g;
        const morph = procMix * (0.5 + 0.5 * Math.sin(wall * 0.55 + seed.phase));
        blobPath(ox, oy, r * (0.92 - i * 0.035), seed, t, amp, morph);
        ctx.fill();
      });
      ctx.restore();

      // Glassy core: darkens the centre slightly so icons read, plus a highlight
      ctx.save();
      ctx.translate(shake, 0);
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 0.85);
      core.addColorStop(0, `rgba(12, 10, 20, ${0.34 + procMix * 0.18})`);
      core.addColorStop(1, 'rgba(12, 10, 20, 0)');
      ctx.fillStyle = core;
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.85, 0, TAU); ctx.fill();
      const hl = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.45, 0, cx - r * 0.35, cy - r * 0.45, r * 0.7);
      hl.addColorStop(0, 'rgba(255,255,255,0.22)');
      hl.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = hl;
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.95, 0, TAU); ctx.fill();
      if (errorMix > 0.02) {
        ctx.fillStyle = `rgba(255, 90, 105, ${errorMix * 0.35})`;
        ctx.beginPath(); ctx.arc(cx, cy, r * 0.98, 0, TAU); ctx.fill();
      }
      ctx.restore();

    }

    raf = requestAnimationFrame(frame);

    return {
      setLevel(v) { target = Math.max(0, Math.min(1, Number(v) || 0)); },
      setState(s) {
        if (s === 'done' && state !== 'done') {
          const now = performance.now();
          ripples.push({ born: now, i: 0 }, { born: now + 160, i: 2 }, { born: now + 320, i: 3 });
        }
        state = s;
        if (s !== 'listening') target = 0;
      },
      setPalette(p) { if (Array.isArray(p) && p.length >= 4) palette = p; },
      get state() { return state; },
      destroy() { destroyed = true; cancelAnimationFrame(raf); }
    };
  }

  function hexA(hex, a) {
    const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(String(hex).trim());
    if (!m) return `rgba(180,160,255,${a})`;
    return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${Math.max(0, Math.min(1, a))})`;
  }

  root.createBloomOrb = createBloomOrb;
})(typeof window !== 'undefined' ? window : globalThis);
