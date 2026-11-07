// Shared Web Audio context (the pads play through it) and the one remaining sound effect:
// the thump when MOSH is hit.

let ac = null, out = null, noise = null;

// Create / wake the audio engine. Call from a user gesture.
export function audio() {
  if (!ac) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ac = new AC({ latencyHint: "interactive" });
    out = ac.createGain();
    out.gain.value = 0.5;
    out.connect(ac.destination);
    noise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ac.state === "suspended") ac.resume();
  return ac;
}

function env(peak, attack, decay, t0) {
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  return g;
}

export const sfx = {
  // MOSH hit: a short noise burst + low thump
  shock() {
    if (!audio()) return;
    const t = ac.currentTime;
    const n = ac.createBufferSource(), lp = ac.createBiquadFilter();
    n.buffer = noise;
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(4000, t);
    lp.frequency.exponentialRampToValueAtTime(180, t + 0.5);
    n.connect(lp).connect(env(0.36, 0.005, 0.5, t)).connect(out);
    n.start(t); n.stop(t + 0.6);
    const o = ac.createOscillator();
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(35, t + 0.45);
    o.connect(env(0.4, 0.005, 0.45, t)).connect(out);
    o.start(t); o.stop(t + 0.55);
  },
};
