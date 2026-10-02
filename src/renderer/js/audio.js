// ==========================================================
// Audio helpers: WebM → 16 kHz mono WAV (for the on-device
// engine), synthesized UI chimes, and level-meter bars.
// ==========================================================
(function (root) {
  // Decode whatever MediaRecorder produced and resample to 16 kHz mono PCM16.
  async function toWav16k(blob) {
    const buf = await blob.arrayBuffer();
    const ctx = new (root.AudioContext || root.webkitAudioContext)();
    let decoded;
    try { decoded = await ctx.decodeAudioData(buf.slice(0)); } finally { ctx.close().catch(() => {}); }
    const rate = 16000;
    const frames = Math.max(1, Math.ceil(decoded.duration * rate));
    const offline = new OfflineAudioContext(1, frames, rate);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    const rendered = await offline.startRendering();
    const pcm = rendered.getChannelData(0);
    const out = new ArrayBuffer(44 + pcm.length * 2);
    const v = new DataView(out);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE');
    w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, pcm.length * 2, true);
    let o = 44;
    for (let i = 0; i < pcm.length; i++, o += 2) {
      const s = Math.max(-1, Math.min(1, pcm[i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return { wav: out, durationSec: decoded.duration };
  }

  // Soft two-note chimes made with oscillators; no audio files shipped.
  let chimeCtx = null;
  // Created at startup (warm()), not on the first chime: creating an AudioContext
  // on a slow laptop made the start chime late.
  function warm() {
    try { chimeCtx = chimeCtx || new (root.AudioContext || root.webkitAudioContext)(); } catch { /* no audio output */ }
  }
  function chime(kind) {
    try {
      warm();
      const ctx = chimeCtx;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const notes = {
        start: [[659.25, 0], [987.77, 0.07]],
        stop: [[880, 0], [587.33, 0.07]],
        done: [[783.99, 0], [1046.5, 0.06], [1318.5, 0.12]],
        error: [[311.13, 0], [233.08, 0.1]]
      }[kind] || [];
      const t0 = ctx.currentTime + 0.01;
      for (const [freq, at] of notes) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, t0 + at);
        gain.gain.linearRampToValueAtTime(kind === 'error' ? 0.05 : 0.07, t0 + at + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.32);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0 + at);
        osc.stop(t0 + at + 0.34);
      }
    } catch { /* audio output unavailable */ }
  }

  // Bars that follow a 0..1 level with a gentle bell-shaped profile.
  function createMeter(el, count = 22) {
    if (!el) return { set() {}, reset() {} };
    el.replaceChildren(...Array.from({ length: count }, () => document.createElement('i')));
    const bars = [...el.children];
    const shape = bars.map((_, i) => 0.35 + 0.65 * Math.sin(Math.PI * (i + 0.5) / count));
    let tick = 0;
    return {
      set(level) {
        tick++;
        el.classList.toggle('live', level > 0.02);
        bars.forEach((b, i) => {
          const jitter = 0.75 + 0.25 * Math.sin(tick * 0.9 + i * 1.7);
          b.style.height = `${4 + level * 22 * shape[i] * jitter}px`;
        });
      },
      reset() { el.classList.remove('live'); bars.forEach((b) => { b.style.height = '4px'; }); }
    };
  }

  root.FreesiaAudio = { toWav16k, chime, createMeter, warm };
})(typeof window !== 'undefined' ? window : globalThis);
