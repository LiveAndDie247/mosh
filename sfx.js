// MOSH PAINT sounds: all synthesized with Web Audio, all original.
// One-shots (boom, whoosh, nope, boing, shock) and "voices" that play while a tool is in use.

let ac = null, out = null, noise = null, crush = null;
let muted = (() => { try { return localStorage.getItem("mosh.muted") === "1"; } catch { return false; } })();

export const isMuted = () => muted;
export function setMuted(m) {
  muted = m;
  try { localStorage.setItem("mosh.muted", m ? "1" : "0"); } catch {}
  if (out) out.gain.setTargetAtTime(m ? 0 : 0.5, ac.currentTime, 0.02);
}

// Create / wake the audio engine. Call from a user gesture.
export function audio() {
  if (!ac) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ac = new AC();
    out = ac.createGain();
    out.gain.value = muted ? 0 : 0.5;
    const comp = ac.createDynamicsCompressor();
    out.connect(comp).connect(ac.destination);
    noise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    crush = ac.createWaveShaper();                       // bitcrusher: a staircase curve
    const n = 256, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.round(x * 4) / 4; }
    crush.curve = curve;
    crush.connect(out);
  }
  if (ac.state === "suspended") ac.resume();
  return ac;
}

const now = () => ac.currentTime;
function env(peak, attack, decay, t0 = now()) {
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  return g;
}
function noiseSrc() { const s = ac.createBufferSource(); s.buffer = noise; s.loop = true; return s; }
function osc(type, f) { const o = ac.createOscillator(); o.type = type; o.frequency.value = f; return o; }
function filt(type, f, q = 1) { const b = ac.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; }

export const sfx = {
  // EXPLODE: noise burst + low thump
  boom(power = 1) {
    if (!audio()) return;
    const t = now();
    const n = noiseSrc(), lp = filt("lowpass", 4000);
    lp.frequency.setValueAtTime(4000, t);
    lp.frequency.exponentialRampToValueAtTime(180, t + 0.5);
    n.connect(lp).connect(env(0.8 * power, 0.005, 0.6, t)).connect(out);
    n.start(t); n.stop(t + 0.7);
    const o = osc("sine", 120);
    o.frequency.exponentialRampToValueAtTime(35, t + 0.45);
    o.connect(env(0.9 * power, 0.005, 0.5, t)).connect(out);
    o.start(t); o.stop(t + 0.6);
  },
  // MOSH hit: a shorter, softer thump
  shock() { this.boom(0.45); },
  // WIPE: a filtered whoosh
  whoosh() {
    if (!audio()) return;
    const t = now(), n = noiseSrc(), bp = filt("bandpass", 300, 1.4);
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(3200, t + 0.25);
    bp.frequency.exponentialRampToValueAtTime(250, t + 0.65);
    n.connect(bp).connect(env(0.7, 0.15, 0.5, t)).connect(out);
    n.start(t); n.stop(t + 0.75);
  },
  // UNDO: "nope" (two notes going down)
  nope() {
    if (!audio()) return;
    const t = now();
    [[330, 0, 0.11], [220, 0.13, 0.2]].forEach(([f, at, len]) => {
      const o = osc("square", f), lp = filt("lowpass", 1800);
      o.connect(lp).connect(env(0.25, 0.005, len, t + at)).connect(out);
      o.start(t + at); o.stop(t + at + len + 0.05);
    });
  },
  // STAMP: boing
  boing() {
    if (!audio()) return;
    const t = now(), o = osc("sine", 700), lfo = osc("sine", 18), depth = ac.createGain();
    depth.gain.value = 30;
    lfo.connect(depth).connect(o.frequency);
    o.frequency.setValueAtTime(700, t);
    o.frequency.exponentialRampToValueAtTime(160, t + 0.28);
    o.connect(env(0.45, 0.005, 0.32, t)).connect(out);
    o.start(t); lfo.start(t); o.stop(t + 0.4); lfo.stop(t + 0.4);
  },
};

// A sound that plays while a tool is in use: { update(speed px/s, yNorm 0..1), stop() }, or null
export function voice(tool) {
  if (!audio()) return null;
  const t = now();
  const fadeOut = (g, nodes) => {
    const tt = now();
    g.gain.cancelScheduledValues(tt);
    g.gain.setTargetAtTime(0.0001, tt, 0.05);
    for (const n of nodes) n.stop(tt + 0.3);
  };

  if (tool === "smear") {                    // squelchy filtered noise that follows finger speed
    const n = noiseSrc(), bp = filt("bandpass", 300, 6), lfo = osc("sine", 11), lfoG = ac.createGain(), g = ac.createGain();
    lfoG.gain.value = 0; g.gain.value = 0.0001;
    lfo.connect(lfoG).connect(bp.frequency);
    n.connect(bp).connect(g).connect(out);
    n.start(t); lfo.start(t);
    return {
      update(speed) {
        const s = Math.min(1, speed / 2500), tt = now();
        bp.frequency.setTargetAtTime(250 + s * 1600, tt, 0.03);
        lfoG.gain.setTargetAtTime(80 + s * 500, tt, 0.05);
        g.gain.setTargetAtTime(0.04 + s * 0.5, tt, 0.03);
      },
      stop() { fadeOut(g, [n, lfo]); },
    };
  }
  if (tool === "swirl" || tool === "melt") {  // swirl: rising wobble; melt: sliding down
    const up = tool === "swirl";
    const o = osc(up ? "sine" : "triangle", up ? 220 : 700), lfo = osc("sine", up ? 7 : 5), depth = ac.createGain(), g = ac.createGain();
    depth.gain.setValueAtTime(10, t);
    depth.gain.linearRampToValueAtTime(up ? 60 : 25, t + 2);
    lfo.connect(depth).connect(o.frequency);
    o.frequency.setValueAtTime(up ? 220 : 700, t);
    o.frequency.exponentialRampToValueAtTime(up ? 900 : 60, t + 2.5);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.2, t + 0.05);
    o.connect(g).connect(out);
    o.start(t); lfo.start(t);
    return { update() {}, stop() { fadeOut(g, [o, lfo]); } };
  }
  if (tool === "colorrot") {                 // warbly beating pair, pitch follows the finger height
    const a = osc("sine", 330), b = osc("sine", 335), g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.15, t + 0.05);
    a.connect(g); b.connect(g); g.connect(out);
    a.start(t); b.start(t);
    return {
      update(_s, y) { const f = 200 + (1 - y) * 500, tt = now(); a.frequency.setTargetAtTime(f, tt, 0.05); b.frequency.setTargetAtTime(f * 1.015, tt, 0.05); },
      stop() { fadeOut(g, [a, b]); },
    };
  }
  if (tool === "pixelate" || tool === "rewind" || tool === "shatter") {
    // Repeating blips while held: bitcrushed notes / rewind zips / glass crunches
    const scale = [262, 330, 392, 523, 659, 784];
    const blip = () => {
      const tt = now();
      if (tool === "pixelate") {
        const o = osc("square", scale[(Math.random() * scale.length) | 0]);
        o.connect(env(0.22, 0.003, 0.06, tt)).connect(crush);
        o.start(tt); o.stop(tt + 0.08);
      } else if (tool === "rewind") {
        const o = osc("sawtooth", 180);
        o.frequency.exponentialRampToValueAtTime(1400, tt + 0.09);
        o.connect(filt("lowpass", 2500)).connect(env(0.14, 0.005, 0.09, tt)).connect(out);
        o.start(tt); o.stop(tt + 0.12);
      } else {
        const n = noiseSrc();
        n.connect(filt("highpass", 1500 + Math.random() * 2500)).connect(env(0.35, 0.002, 0.04, tt)).connect(out);
        n.start(tt); n.stop(tt + 0.06);
      }
    };
    blip();
    const every = tool === "pixelate" ? 110 : tool === "rewind" ? 140 : 70;
    const id = setInterval(blip, every);
    return { update() {}, stop() { clearInterval(id); } };
  }
  return null;                               // explode / stamp are one-shots
}
