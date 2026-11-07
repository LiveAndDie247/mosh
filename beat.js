// BPM from a song: decode it, take an onset-energy envelope (positive changes in loudness in
// ~11 ms hops), autocorrelate it over 70–180 BPM and take the strongest lag. Good enough to put
// cuts on the beat; TAP tempo fixes anything it gets wrong.
export async function detectBpm(ac, file) {
  const buf = await ac.decodeAudioData(await file.arrayBuffer());
  const d = buf.getChannelData(0), sr = buf.sampleRate;
  const hop = Math.round(sr / 90);                       // 90 envelope samples per second
  const from = Math.min(d.length, Math.round(sr * 10)), to = Math.min(d.length, from + sr * 40);
  const env = [];
  let prev = 0;
  for (let i = (to - from > sr * 8 ? from : 0); i + hop < (to - from > sr * 8 ? to : d.length); i += hop) {
    let e = 0;
    for (let j = 0; j < hop; j++) e += d[i + j] * d[i + j];
    e = Math.sqrt(e / hop);
    env.push(Math.max(0, e - prev));
    prev = e;
  }
  if (env.length < 300) return { bpm: 120, duration: buf.duration, sure: false };
  const fps = sr / hop;
  let best = 0, bestLag = 0;
  for (let bpm = 70; bpm <= 180; bpm += 0.5) {
    const lag = (60 / bpm) * fps;
    let s = 0;
    for (let i = 0; i + lag * 2 < env.length; i++) s += env[i] * (env[Math.round(i + lag)] + 0.5 * env[Math.round(i + 2 * lag)]);
    if (s > best) { best = s; bestLag = bpm; }
  }
  return { bpm: Math.round(bestLag), duration: buf.duration, sure: true };
}

// TAP tempo: the average of the last few taps (resets after a 2 s gap)
export function tapper() {
  let taps = [];
  return () => {
    const t = performance.now();
    if (taps.length && t - taps[taps.length - 1] > 2000) taps = [];
    taps.push(t);
    if (taps.length > 8) taps.shift();
    if (taps.length < 2) return null;
    return Math.round(60000 / ((taps[taps.length - 1] - taps[0]) / (taps.length - 1)));
  };
}
