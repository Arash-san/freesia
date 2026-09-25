// Minimal PCM16 WAV helpers: parse, split long audio at pauses, re-encode.
// Renderer sends 16 kHz mono PCM16 WAV to the local engine.

function parseWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAV file');
  let off = 12;
  let fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = { channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!fmt || fmt.bits !== 16 || fmt.channels !== 1) throw new Error('Expected mono 16-bit PCM');
      const end = Math.min(buf.length, body + size);
      const samples = new Int16Array(buf.buffer.slice(buf.byteOffset + body, buf.byteOffset + end - ((end - body) % 2)));
      return { sampleRate: fmt.sampleRate, samples };
    }
    off = body + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}

function encodeWav(samples, sampleRate) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  Buffer.from(samples.buffer, samples.byteOffset, samples.length * 2).copy(buf, 44);
  return buf;
}

// Cut near every `targetSec` at the quietest 200 ms in the preceding 20 s so
// words are never split. Short audio is returned unchanged.
function splitAtPauses(samples, sampleRate, targetSec = 300) {
  const target = Math.floor(targetSec * sampleRate);
  if (samples.length <= target * 1.1) return [samples];
  const win = Math.floor(0.2 * sampleRate);
  const search = Math.floor(20 * sampleRate);
  const chunks = [];
  let start = 0;
  while (samples.length - start > target * 1.1) {
    const lo = start + target - search;
    const hi = start + target;
    let best = lo;
    let bestEnergy = Infinity;
    let energy = 0;
    for (let i = lo; i < lo + win; i++) energy += samples[i] * samples[i];
    for (let i = lo; i + win < hi; i += 1) {
      if (energy < bestEnergy) { bestEnergy = energy; best = i; }
      energy += samples[i + win] * samples[i + win] - samples[i] * samples[i];
    }
    const cut = best + (win >> 1);
    chunks.push(samples.subarray(start, cut));
    start = cut;
  }
  chunks.push(samples.subarray(start));
  return chunks;
}

module.exports = { parseWav, encodeWav, splitAtPauses };
