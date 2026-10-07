import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { boot } from './helpers.mjs';
const { apply } = createRequire(import.meta.url)('../src/renderer/js/vocab.js');

test('unseen spellings join, while acronyms and prose retain their meaning', () => {
  for (const [source, expected] of [
    ['Ask H A M I D to help.', 'Ask Hamid to help.'],
    ['M O J T A B A and R-E-Z-A', 'Mojtaba and Reza'],
    ['H A M I D I need help', 'Hamid I need help'],
    ['Use G P T, A P I and A I.', 'Use GPT, API and AI.'],
    ['spell B O please', 'spell Bo please'],
    ['write all caps H A M I D', 'write all caps HAMID'],
    ['ح م ی د', 'حمید'],
    ['h a m i d', 'hamid'],
    ['I a little later', 'I a little later'],
    ['J. R. R. Tolkien', 'J. R. R. Tolkien'],
    ['Ask H. A. M. I. D. about G. P. T.', 'Ask Hamid about GPT.'],
    ['A + B = C', 'A + B = C'],
    ['H A\nM I D', 'H A\nMid'],
    ['The cloud is cloudy.', 'The cloud is cloudy.'],
  ]) {
    assert.equal(apply(source), expected, source);
    assert.equal(apply(expected), expected, 'idempotence: ' + source);
  }
  assert.equal(apply('P Y T O R C H', ['PyTorch']), 'PyTorch');
});

test('final delivery cleans spelling again when the formatter reintroduces it', async () => {
  const { t, dom, calls, window } = await boot({ toolTrimSpelling: false }, {
    transcribe: async () => ({ text: 'Ask H A M I D about G P T.', engine: 'cloud' }),
    format: async () => ({ text: 'Ask H. A. M. I. D. about G. P. T.' }),
  });
  await t.processAudio(new window.Blob(['x']), 'dictate-inject', { durationSec: 3 });
  assert.deepEqual(calls.inject, ['Ask Hamid about GPT.']);
  dom.window.close();
});

test('spelling cleanup also runs with formatting switched off', async () => {
  const { t, dom, calls, window } = await boot({ aiFormatting: false }, {
    transcribe: async () => ({ text: 'Ask H A M I D.', engine: 'local' }),
  });
  await t.processAudio(new window.Blob(['x']), 'dictate-inject', { durationSec: 3 });
  assert.deepEqual(calls.inject, ['Ask Hamid.']);
  assert.equal(calls.format.length, 0);
  dom.window.close();
});
