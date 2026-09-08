import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAudioMeter } from '../src/renderer/audio-meter.js';
const tone = amplitude => Float32Array.from({ length: 2048 }, (_, i) => amplitude * Math.sin(i * 0.1));
test('quiet and loud microphones produce comparable animated speech envelopes', () => {
  function trace(gain) {
    const meter = createAudioMeter();
    return [1, 1, 1, 0.4, 0.15, 0, 0, 0, 1, 1].map(envelope => meter.sample(tone(gain * envelope)));
  }
  const quiet = trace(0.005), loud = trace(0.8);
  for (let i = 0; i < quiet.length; i++) assert.ok(Math.abs(quiet[i] - loud[i]) < 0.04);
  assert.ok(quiet[2] > 0.7, 'quiet speech is visible');
  assert.ok(quiet[6] < quiet[2] / 2, 'pauses visibly fall');
  assert.ok(loud.every(v => v < 0.9), 'loud input leaves headroom');
});
test('silence and DC offset stay flat; speech releases fully to silence', () => {
  const meter = createAudioMeter();
  assert.equal(meter.sample(tone(0)), 0);
  assert.equal(meter.sample(new Float32Array(2048).fill(0.25)), 0);
  meter.sample(tone(0.5));
  let value;
  for (let i = 0; i < 12; i++) value = meter.sample(tone(0));
  assert.equal(value, 0);
});
