use crate::engines::{Error, Result};
pub fn parse(b: &[u8]) -> Result<(u32, Vec<i16>)> {
    if b.len() < 12 || &b[..4] != b"RIFF" || &b[8..12] != b"WAVE" {
        return Err(Error::new("audio", "Not a WAV file"));
    }
    let mut off = 12;
    let mut rate = 0;
    while off + 8 <= b.len() {
        let size = u32::from_le_bytes(b[off + 4..off + 8].try_into().unwrap()) as usize;
        let body = off + 8;
        if &b[off..off + 4] == b"fmt " {
            if size < 16 || body + 16 > b.len() {
                break;
            }
            let pcm = u16::from_le_bytes(b[body..body + 2].try_into().unwrap());
            let channels = u16::from_le_bytes(b[body + 2..body + 4].try_into().unwrap());
            let bits = u16::from_le_bytes(b[body + 14..body + 16].try_into().unwrap());
            if pcm != 1 || channels != 1 || bits != 16 {
                return Err(Error::new("audio", "Expected mono 16-bit PCM"));
            }
            rate = u32::from_le_bytes(b[body + 4..body + 8].try_into().unwrap());
        }
        if &b[off..off + 4] == b"data" {
            if rate == 0 || rate > 384000 {
                return Err(Error::new("audio", "Invalid sample rate"));
            }
            let end = body.saturating_add(size).min(b.len());
            return Ok((
                rate,
                b[body..end]
                    .chunks_exact(2)
                    .map(|c| i16::from_le_bytes([c[0], c[1]]))
                    .collect(),
            ));
        }
        off = body.saturating_add(size).saturating_add(size % 2);
    }
    Err(Error::new("audio", "WAV has no data chunk"))
}
pub fn encode(samples: &[i16], rate: u32) -> Vec<u8> {
    let mut b = Vec::with_capacity(44 + samples.len() * 2);
    b.extend(b"RIFF");
    b.extend((36 + samples.len() as u32 * 2).to_le_bytes());
    b.extend(b"WAVEfmt ");
    b.extend(16u32.to_le_bytes());
    b.extend(1u16.to_le_bytes());
    b.extend(1u16.to_le_bytes());
    b.extend(rate.to_le_bytes());
    b.extend((rate * 2).to_le_bytes());
    b.extend(2u16.to_le_bytes());
    b.extend(16u16.to_le_bytes());
    b.extend(b"data");
    b.extend((samples.len() as u32 * 2).to_le_bytes());
    for s in samples {
        b.extend(s.to_le_bytes())
    }
    b
}
pub fn split(samples: &[i16], rate: u32) -> Vec<&[i16]> {
    let target = 300 * rate as usize;
    let search = 20 * rate as usize;
    let win = (rate as usize / 5).max(1);
    let mut start = 0;
    let mut chunks = vec![];
    while samples.len() - start > target * 11 / 10 {
        let lo = start + target - search;
        let hi = start + target;
        let mut best = lo;
        let mut energy: i64 = samples[lo..lo + win]
            .iter()
            .map(|s| i64::from(*s).pow(2))
            .sum();
        let mut min = i64::MAX;
        for i in lo..hi - win {
            if energy < min {
                min = energy;
                best = i
            }
            energy += i64::from(samples[i + win]).pow(2) - i64::from(samples[i]).pow(2);
        }
        let cut = best + win / 2;
        chunks.push(&samples[start..cut]);
        start = cut;
    }
    chunks.push(&samples[start..]);
    chunks
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roundtrip_and_malformed() {
        let samples = vec![0, 1, -1, 32767, -32768];
        assert_eq!(parse(&encode(&samples, 16000)).unwrap(), (16000, samples));
        assert!(parse(b"invalid").is_err());
    }
    #[test]
    fn splits_without_dropping_samples() {
        let samples = vec![100; 16000 * 650];
        let chunks = split(&samples, 16000);
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks.iter().map(|c| c.len()).sum::<usize>(), samples.len());
    }
}
