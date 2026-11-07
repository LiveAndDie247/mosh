/* gate-kit · stars-bg — the blinking-star background, the reactive version.
 *
 * The same sky as img/stars.gif, drawn on a fixed low-res canvas behind the page: 1 canvas pixel =
 * 2 CSS pixels with a nearest-neighbour upscale, so the stars stay chunky like an old GIF. Three
 * depths scroll with the page at different speeds. Everything blinks in hard steps, 9 steps a second.
 * Reacts: stars near the pointer or finger wake up into sparkles and leave a trail of them; a tap
 * throws a burst; a fast scroll streaks the stars; tilting the phone slides the near stars; every so
 * often a shooting star crosses.
 * With prefers-reduced-motion it does nothing and gate.css shows the still tile. Never on /x/ pages.
 *
 *   <script src="/gate/stars-bg.js" defer></script>
 * API: window.GateStars.burst(xCss, yCss, strength)   (1 = tap, 3 = big)
 *      window.GateMosh.shock(...) still works and does the same thing.
 */
(function () {
  "use strict";
  if (/^\/x\//.test(location.pathname)) return;
  window.GateStars = { burst: function () {}, state: function () { return { mode: "off" }; } };
  window.GateMosh = { shock: function (x, y, k) { window.GateStars.burst(x, y, k); } };
  var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) return;

  var PX = 2, TICK = 110, T = 240;                      // CSS px per canvas px · ms per step · tile size (canvas px)
  var COL = { w: "#ffffff", b: "#9a9aff", p: "#c8c8ff", r: "#ff4040", d0: "#464656", d1: "#606074", d2: "#7c7c94" };
  var PICK = [COL.w, COL.w, COL.p, COL.b, COL.b, COL.r];
  var SPARK = [0, 1, 2, 3, 3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];   // sparkle arm length per step

  var seed = 333;                                       // the same sky on every visit
  function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
  function layer(n, p, kind) {                          // kind 0 = dust, 1 = far stars, 2 = near stars
    var st = [];
    for (var i = 0; i < n; i++) {
      var t = rnd(), c;
      if (kind === 0) c = t < 0.33 ? COL.d0 : t < 0.66 ? COL.d1 : COL.d2;
      else c = t < 0.2 ? COL.b : t < 0.28 ? COL.r : t < 0.38 ? COL.p : COL.w;
      var per = 6 + Math.floor(rnd() * 16);
      st.push({ x: Math.floor(rnd() * T), y: Math.floor(rnd() * T), c: c, s: kind === 2 && rnd() < 0.5 ? 2 : 1,
        ph: Math.floor(rnd() * 64), per: per, lit: Math.round(per * (0.55 + rnd() * 0.3)),
        bl: kind > 0 || rnd() < 0.1, sp: kind === 2 && rnd() < 0.22 });
    }
    return { p: p, st: st };
  }
  var L = [layer(90, 0.25, 0), layer(36, 0.55, 1), layer(22, 1, 2)];

  var cv = document.createElement("canvas"), x = null, W = 0, H = 0, cssW = 1, cssH = 1;
  cv.setAttribute("aria-hidden", "true");
  cv.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;height:100lvh;z-index:-1;pointer-events:none;" +
    "image-rendering:pixelated;image-rendering:crisp-edges;background:#000";
  function size() {
    var r = cv.getBoundingClientRect(); cssW = Math.max(1, r.width); cssH = Math.max(1, r.height);
    W = Math.ceil(cssW / PX); H = Math.ceil(cssH / PX); cv.width = W; cv.height = H;
  }

  var tick = 0, sy = 0, vel = 0, ox = 0, oxT = 0, tilt = 0, pxC = -1, pyC = -1, lastPtr = -1e9, lastTrail = 0;
  var parts = [], meteor = null, lastMeteor = 0, gap = 9000;
  var raf = 0, timer = 0, lastFrame = 0, lastTick = 0;

  function dot(X, Y, s, c) { x.fillStyle = c; x.fillRect(X, Y, s, s); }
  function cross(X, Y, arm, c) {
    x.fillStyle = c;
    if (arm > 2) {                                      // dim tips, like the GIF
      x.fillRect(X - 2, Y, 5, 1); x.fillRect(X, Y - 2, 1, 5);
      x.globalAlpha = 0.5; x.fillRect(X - arm, Y, arm - 2, 1); x.fillRect(X + 3, Y, arm - 2, 1); x.fillRect(X, Y - arm, 1, arm - 2); x.fillRect(X, Y + 3, 1, arm - 2); x.globalAlpha = 1;
    } else { x.fillRect(X - arm, Y, 2 * arm + 1, 1); x.fillRect(X, Y - arm, 1, 2 * arm + 1); }
  }

  function draw() {
    x.fillStyle = "#000"; x.fillRect(0, 0, W, H);
    var streak = Math.abs(vel) > 500 ? Math.min(14, Math.abs(vel) / 160) : 0, down = vel > 0;
    var ptr = pxC >= 0 && performance.now() - lastPtr < 1500, R2 = 34 * 34;
    var cols = Math.ceil(W / T) + 1, rows = Math.ceil(H / T) + 1;
    for (var li = 0; li < 3; li++) {
      var Ly = L[li], p = Ly.p, st = Ly.st, oy = ((sy / PX) * p) % T, oxp = ox * p;
      for (var ty = 0; ty < rows; ty++) for (var tx = -1; tx < cols; tx++) {
        var tph = ((tx * 7 + ty * 13) & 15) * 3;         // each copy of the tile blinks on its own beat
        for (var i = 0; i < st.length; i++) {
          var s = st[i], X = Math.round(s.x + tx * T - oxp), Y = Math.round(s.y + ty * T - oy);
          if (X < -4 || X > W + 4 || Y < -4 || Y > H + 4) continue;
          var k = tick + s.ph + tph;
          if (s.bl && k % s.per >= s.lit) continue;       // off this step
          if (s.sp) { var arm = SPARK[k % 24]; if (arm) { cross(X, Y, arm, s.c); continue; } }
          if (ptr && li > 0) { var dx = X - pxC, dy = Y - pyC; if (dx * dx + dy * dy < R2) { cross(X, Y, (k & 1) ? 2 : 1, li === 2 ? COL.w : s.c); continue; } }
          if (streak && li > 0) { var len = Math.round(streak * p); if (len > 1) { x.globalAlpha = 0.5; x.fillStyle = s.c; x.fillRect(X, down ? Y : Y - len, s.s, len); x.globalAlpha = 1; } }
          dot(X, Y, s.s, s.c);
        }
      }
    }
    for (var n = 0; n < parts.length; n++) {
      var q = parts[n], qx = Math.round(q.x), qy = Math.round(q.y);
      if (q.big) { cross(qx, qy, 6, COL.w); continue; }
      var a = q.life >= 7 ? 3 : q.life >= 4 ? 2 : q.life >= 2 ? 1 : 0;
      if (a) cross(qx, qy, a, q.c); else dot(qx, qy, 1, q.c);
    }
    if (meteor) {
      for (var m = 0; m < meteor.tr.length; m++) { x.globalAlpha = 1 - m / meteor.tr.length; dot(meteor.tr[m][0], meteor.tr[m][1], 1, m < 2 ? COL.w : COL.p); }
      x.globalAlpha = 1; cross(Math.round(meteor.x), Math.round(meteor.y), 1, COL.w);
    }
  }

  // ---------- the stepped things: particles and the shooting star ----------
  function step() {
    for (var n = parts.length - 1; n >= 0; n--) {
      var q = parts[n]; q.x += q.vx; q.y += q.vy; q.vx *= 0.88; q.vy = q.vy * 0.88 + 0.12; q.life--;
      if (q.life <= 0 || q.y > H + 4) parts.splice(n, 1);
    }
    if (meteor) {
      meteor.tr.unshift([Math.round(meteor.x), Math.round(meteor.y)]); if (meteor.tr.length > 7) meteor.tr.pop();
      meteor.x += meteor.vx; meteor.y += meteor.vy;
      if (meteor.x < -8 || meteor.x > W + 8 || meteor.y > H + 8) meteor = null;
    }
  }
  function spawn(X, Y, n, k) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * 6.2832, v = (1 + Math.random() * 3) * k;
      parts.push({ x: X, y: Y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 4 + Math.floor(Math.random() * 5 * k), c: PICK[Math.floor(Math.random() * PICK.length)] });
    }
    if (parts.length > 400) parts.splice(0, parts.length - 400);
  }
  function burst(xCss, yCss, k) {
    k = k || 1; var X = xCss / PX, Y = yCss / PX;
    spawn(X, Y, Math.round(14 + 10 * k), k); parts.push({ x: X, y: Y, vx: 0, vy: 0, life: 2, big: true, c: COL.w });
    wake();
  }
  function shoot() {
    var fromLeft = Math.random() < 0.5, vx = (4 + Math.random() * 4) * (fromLeft ? 1 : -1);
    meteor = { x: fromLeft ? -2 : W + 2, y: Math.random() * H * 0.5, vx: vx, vy: 2 + Math.random() * 2.5, tr: [] };
    if (Math.random() < 0.4) { meteor.x = Math.random() * W; meteor.y = -2; }
    lastMeteor = performance.now(); gap = 11000 + Math.random() * 17000; wake();
  }

  // ---------- the loop: 60 fps while scrolling or pointing, otherwise one step every 110 ms ----------
  function loop(now) {
    raf = 0; if (document.hidden) return;
    var y = window.scrollY || 0, dt = Math.max(1, now - lastFrame); lastFrame = now;
    var v = (y - sy) / dt * 1000; sy = y;                 // CSS px per second
    vel += (v - vel) * 0.35;
    ox += (oxT + tilt - ox) * 0.15;                       // sideways parallax: pointer position, or the phone's tilt
    if (now - lastTick >= TICK) { lastTick = now; tick++; step(); }
    draw();
    var busy = Math.abs(vel) > 3 || now - lastPtr < 150;  // smooth only while scrolling or pointing; everything else steps
    clearTimeout(timer);
    if (busy) raf = requestAnimationFrame(loop);
    else timer = setTimeout(function () { if (!raf) raf = requestAnimationFrame(loop); }, Math.max(0, TICK - (performance.now() - lastTick)));
  }
  function wake() { if (document.hidden) return; clearTimeout(timer); if (!raf) raf = requestAnimationFrame(loop); }

  // ---------- inputs ----------
  function onMove(e) {
    var now = performance.now();
    pxC = e.clientX / PX; pyC = e.clientY / PX; lastPtr = now;
    oxT = (e.clientX / cssW - 0.5) * 16;
    if (now - lastTrail > 45) {                          // a trail of sparkles behind the pointer or finger
      lastTrail = now; var a = Math.random() * 6.2832;
      parts.push({ x: pxC, y: pyC, vx: Math.cos(a) * 0.8, vy: Math.sin(a) * 0.8 - 0.3, life: 3 + Math.floor(Math.random() * 4), c: PICK[Math.floor(Math.random() * PICK.length)] });
    }
    wake();
  }
  function onLeave() { pxC = pyC = -1; }
  var down = null;
  function onDown(e) { down = { x: e.clientX, y: e.clientY, t: performance.now() }; onMove(e); }
  function onUp(e) {
    if (down && Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) < 14 && performance.now() - down.t < 450) burst(e.clientX, e.clientY, 1);
    down = null; if (e.pointerType !== "mouse") onLeave();
  }

  function start() {
    x = cv.getContext("2d", { alpha: false }); if (!x) return;    // no canvas: the GIF tile stays
    document.body.insertBefore(cv, document.body.firstChild);
    document.body.style.backgroundImage = "none";                 // the canvas is the sky now; stop painting the GIF under it
    size(); sy = window.scrollY || 0;
    var o = { passive: true };
    addEventListener("scroll", wake, o);
    addEventListener("pointermove", onMove, o);
    addEventListener("pointerdown", onDown, o);
    addEventListener("pointerup", onUp, o);
    addEventListener("pointercancel", function () { down = null; onLeave(); }, o);
    document.addEventListener("pointerleave", onLeave, o);
    addEventListener("deviceorientation", function (e) {   // tilt the phone, the near stars slide (steps with the ticks, so it costs nothing)
      if (e.gamma == null) return; var g = Math.max(-30, Math.min(30, e.gamma)); tilt = Math.round(g / 30 * 12);
    }, o);
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) { if (raf) cancelAnimationFrame(raf); raf = 0; clearTimeout(timer); }
      else { lastFrame = performance.now(); wake(); }
    });
    addEventListener("resize", function () { clearTimeout(start.rt); start.rt = setTimeout(function () { size(); draw(); }, 100); }, o);
    lastMeteor = performance.now();
    setInterval(function () { if (!document.hidden && !meteor && performance.now() - lastMeteor > gap) shoot(); }, 1000);
    window.GateStars.burst = burst;
    window.GateStars.state = function () { return { mode: "canvas", W: W, H: H, tick: tick, parts: parts.length, meteor: !!meteor, running: !!(raf || timer) }; };
    wake();
  }
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
})();
