(function(root) {
  // Visual gain only: the original audio sent for transcription is untouched.
  function createAudioMeter() {
    let peak = 0.002;
    let level = 0;
    return {
      sample(samples) {
        if (!samples.length) return 0;
        let mean = 0;
        for (const value of samples) mean += value;
        mean /= samples.length;
        let power = 0;
        for (const value of samples) power += (value - mean) ** 2;
        const rms = Math.sqrt(power / samples.length);
        // Follow speech peaks quickly and release gain over about two seconds.
        peak = Math.max(rms, peak * 0.975, 0.002);
        const floor = Math.max(0.00015, peak * 0.025);
        const relative = Math.max(0, (rms - floor) / Math.max(peak - floor, 0.001));
        const target = 0.88 * Math.sqrt(Math.min(1, relative));
        level += (target - level) * (target > level ? 0.65 : 0.4);
        if (level < 0.015) level = 0;
        return level;
      }
    };
  }
  if (typeof module !== 'undefined') module.exports = { createAudioMeter };
  else root.createAudioMeter = createAudioMeter;
})(globalThis);
