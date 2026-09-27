// Step 1 of rotated clip masking: the clip is a basis plus a rect, nested clips
// in one basis collapse to a single parallelogram on the CPU, and a clip in a
// second basis throws. Three scenes:
//
//   - a rotating card with a scroll view inside: two clips, one basis, and
//     rotated icons and badges crossing the scroll view's edges;
//   - a deep nest: N clips with every fourth turned 90°, still one rect;
//   - a skewed parent: a non-uniform scale above a rotation makes the clip a
//     parallelogram, with a 90° child clip inside it.
//
// "Mixed basis" turns the scroll view 11.5° inside its card, which step 1
// refuses.

import { SpriteBatch } from './batch.js';
import { createAtlas, TILE } from './atlas.js';
import { Container, Sprite, ClipBasisError, buildFrame, insideUnit } from './nodes.js';
import { compose, apply } from './affine.js';

const DESIGN_W = 1240, DESIGN_H = 860;

const glCanvas = document.getElementById('gl');
const overlay = document.getElementById('overlay');
const g2d = overlay.getContext('2d');
const errorEl = document.getElementById('error');
const statsEl = document.getElementById('stats');

const gl = glCanvas.getContext('webgl2', { antialias: true, alpha: false });
if (!gl) throw new Error('WebGL2 is not available');

const atlas = createAtlas(gl);
const batch = new SpriteBatch(gl, atlas.texture);

const settings = { animate: true, smooth: true, surplus: false, outlines: false, mixed: false, depth: 24 };

// Any setting can come from the URL (?surplus&outlines&depth=40, animate=0),
// and ?t=3.2 starts the clock there — handy for a still to compare against.
const params = new URLSearchParams(location.search);
for (const key of Object.keys(settings)) {
  if (!params.has(key)) continue;
  const v = params.get(key);
  settings[key] = typeof settings[key] === 'number' ? Math.min(40, Math.max(1, Number(v) || 1)) : v !== '0';
}
let root = makeScene();

// ---------------------------------------------------------------- scene

function makeScene() {
  return new Container({ name: 'root' }).add(scrollCard(), deepNest(settings.depth), skewedParent());
}

function scrollCard() {
  const ROWS = 14, ROW_H = 58, VIEW_H = 340;

  const card = new Container({
    name: 'card', x: 230, y: 420, clip: { x: -160, y: -230, w: 320, h: 460 },
    animate: (n, t) => { n.rotation = 0.35 * Math.sin(t * 0.6); },
  });
  card.add(
    new Sprite({ name: 'card bg', x: -160, y: -230, w: 320, h: 460, tint: rgba('#1d2433') }),
    new Sprite({ name: 'header', x: -160, y: -230, w: 320, h: 56, tint: rgba('#3b5bdb') }),
    spinner({ name: 'corner checker', cx: 160, cy: -230, size: 110, tile: TILE.CHECKER, speed: 0.7 }),
  );

  const scroll = new Container({
    name: 'scroll view', y: 40, clip: { x: -140, y: -170, w: 280, h: VIEW_H },
    animate: (n) => { n.rotation = settings.mixed ? 0.2 : 0; },
  });
  const list = new Container({
    name: 'list', x: -132,
    animate: (n, t) => {
      const travel = ROWS * ROW_H - VIEW_H + 12;
      n.y = -164 - (0.5 - 0.5 * Math.cos(t * 0.45)) * travel;
    },
  });
  for (let i = 0; i < ROWS; i++) {
    list.add(new Container({ name: `row ${i}`, y: i * ROW_H }).add(
      new Sprite({ name: `row ${i} bg`, w: 264, h: 50, tint: rgba(i % 2 ? '#2a3350' : '#243049') }),
      spinner({ name: `row ${i} icon`, cx: 28, cy: 25, size: 40, tile: TILE.DISC, speed: 1.2 + i * 0.13 }),
      // Pokes past the scroll view's right edge, rotated: the boxed path.
      new Sprite({
        name: `row ${i} badge`, x: 224, y: 12, w: 64, h: 28, rotation: -0.28,
        tile: TILE.STRIPES, tint: rgba('#ffd166'),
      }),
    ));
  }
  scroll.add(new Sprite({ name: 'scroll bg', x: -140, y: -170, w: 280, h: VIEW_H, tint: rgba('#141a26') }), list);
  card.add(scroll);
  return card;
}

function deepNest(depth) {
  const top = new Container({
    name: 'nest', x: 620, y: 420,
    animate: (n, t) => { n.rotation = 0.6 + t * 0.12; },
  });
  let parent = top;
  for (let i = 0; i < depth; i++) {
    const w = Math.max(90, 360 - i * 6), h = Math.max(70, 290 - i * 5);
    const level = new Container({
      name: `level ${i}`, rotation: i % 4 === 3 ? Math.PI / 2 : 0,
      clip: { x: -w / 2, y: -h / 2, w, h },
      animate: (n, t) => {
        n.x = 7 * Math.sin(t * 0.9 + i * 0.7);
        n.y = 7 * Math.cos(t * 0.7 + i * 1.3);
      },
    });
    level.add(new Sprite({
      name: `level ${i} fill`, x: -w / 2, y: -h / 2, w, h,
      tint: hsla((200 + i * 9) % 360, 45, 18 + (i % 2) * 9),
    }));
    parent.add(level);
    parent = level;
  }
  parent.add(spinner({ name: 'innermost checker', cx: 0, cy: 0, size: 280, tile: TILE.CHECKER, speed: 0.35 }));
  for (let k = 0; k < 3; k++) {
    parent.add(new Sprite({
      name: `orbiter ${k}`, w: 56, h: 56, pivotX: 28, pivotY: 28, tile: TILE.DISC,
      animate: (n, t) => {
        const a = t * 0.6 + k * (Math.PI * 2 / 3);
        n.x = 110 * Math.cos(a);
        n.y = 110 * Math.sin(a);
        n.rotation = t * 2;
      },
    }));
  }
  return top;
}

function skewedParent() {
  const outer = new Container({ name: 'skewed parent', x: 1010, y: 420, scaleX: 1.5, scaleY: 0.78 });
  const spin = new Container({
    name: 'rotated clip', clip: { x: -110, y: -110, w: 220, h: 220 },
    animate: (n, t) => { n.rotation = t * 0.25; },
  });
  spin.add(new Sprite({ name: 'skew bg', x: -110, y: -110, w: 220, h: 220, tile: TILE.STRIPES, tint: rgba('#6c5ce7') }));

  // Parallel to the clip: clamped corners, no fragment test.
  const grid = new Container({
    name: 'grid',
    animate: (n, t) => { n.x = 40 * Math.sin(t * 0.5); n.y = 30 * Math.cos(t * 0.4); },
  });
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      grid.add(new Sprite({
        name: `cell ${r},${c}`, x: -150 + c * 62, y: -150 + r * 62, w: 52, h: 52,
        tile: TILE.CHECKER, tint: rgba('#ffffff', 0.85),
      }));
    }
  }
  spin.add(grid);

  spin.add(new Sprite({
    name: 'orbiting disc', w: 90, h: 90, pivotX: 45, pivotY: 45, tile: TILE.DISC,
    animate: (n, t) => { n.x = 95 * Math.cos(t * 0.8); n.y = 95 * Math.sin(t * 0.8); n.rotation = -t * 1.5; },
  }));

  const inner = new Container({ name: '90° clip', x: -30, y: 40, rotation: Math.PI / 2, clip: { x: -55, y: -38, w: 110, h: 76 } });
  inner.add(
    new Sprite({ name: '90° bg', x: -55, y: -38, w: 110, h: 76, tint: rgba('#0b0f18', 0.9) }),
    spinner({ name: '90° spinner', cx: 0, cy: 0, size: 100, tile: TILE.CHECKER, speed: -0.9, tint: rgba('#7ee787') }),
  );
  spin.add(inner);
  outer.add(spin);
  return outer;
}

function spinner({ name, cx, cy, size, tile, speed, tint }) {
  return new Sprite({
    name, x: cx, y: cy, w: size, h: size, pivotX: size / 2, pivotY: size / 2, tile, tint,
    animate: (n, t) => { n.rotation = t * speed; },
  });
}

function rgba(hex, a = 1) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255, Math.round(a * 255)];
}

function hsla(h, s, l, a = 1) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const f = (n) => l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255)).concat(Math.round(a * 255));
}

// ---------------------------------------------------------------- loop

let t = Number(params.get('t')) || 0, last = performance.now(), dpr = 1, pointer = null;
let fpsFrames = 0, fpsSince = last, fps = 0;

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
  if (glCanvas.width !== w || glCanvas.height !== h) {
    glCanvas.width = overlay.width = w;
    glCanvas.height = overlay.height = h;
  }
}

function frame(now) {
  if (settings.animate) t += Math.min(0.05, (now - last) / 1000);
  last = now;
  resize();

  const W = glCanvas.width, H = glCanvas.height;
  const s = Math.min(W / DESIGN_W, H / DESIGN_H);
  const view = compose((W - DESIGN_W * s) / 2, (H - DESIGN_H * s) / 2, 0, s, s, 0, 0);

  let result = null, error = null;
  batch.begin();
  try {
    result = buildFrame(root, batch, view, t, atlas.uvs);
  } catch (e) {
    if (!(e instanceof ClipBasisError)) throw e;
    error = e;
  }

  gl.viewport(0, 0, W, H);
  gl.clearColor(0.063, 0.075, 0.102, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (result) batch.flush(W, H, settings);

  drawOverlay(view, s, result);
  errorEl.style.display = error ? 'block' : 'none';
  if (error) errorEl.textContent = error.message;

  fpsFrames++;
  if (now - fpsSince > 250) {
    fps = fpsFrames * 1000 / (now - fpsSince);
    fpsFrames = 0; fpsSince = now;
    if (result) showStats(result.stats);
  }
  requestAnimationFrame(frame);
}

function showStats(st) {
  statsEl.textContent =
    `instances   ${st.sprites}  (${st.culled} culled)\n` +
    `boxed       ${st.boxed}  rotated vs clip, trimmed per fragment\n` +
    `clips       ${st.clips}  (${st.merged} merged into a parent)\n` +
    `deepest     ${st.maxDepth} clips -> 1 rect\n` +
    `draw calls  1\n` +
    `fps         ${fps.toFixed(0)}`;
}

// ---------------------------------------------------------------- overlay

function drawOverlay(view, s, result) {
  g2d.setTransform(1, 0, 0, 1, 0, 0);
  g2d.clearRect(0, 0, overlay.width, overlay.height);

  const labels = [
    [230, 'Scroll view', 'rotating card, nested clip in the same basis'],
    [620, `Deep nest: ${settings.depth} clips`, 'every 4th turned 90°, collapsed to one rect'],
    [1010, 'Skewed parent', 'parallelogram clip, 90° child clip inside'],
  ];
  g2d.textAlign = 'center';
  for (const [x, title, sub] of labels) {
    const [px, py] = apply(view, x, 770);
    g2d.fillStyle = '#d8dce8';
    g2d.font = `600 ${Math.round(17 * s)}px system-ui, sans-serif`;
    g2d.fillText(title, px, py);
    g2d.fillStyle = '#8b93a8';
    g2d.font = `${Math.round(13 * s)}px system-ui, sans-serif`;
    g2d.fillText(sub, px, py + 20 * s);
  }
  if (!result) return;

  g2d.lineWidth = Math.max(1, dpr);
  if (settings.outlines) {
    g2d.setLineDash([6 * dpr, 4 * dpr]);
    g2d.strokeStyle = 'rgba(80, 220, 255, 0.7)';
    for (const c of result.clips) outline(c);
  }

  // The CPU hit test runs the same math the shader does: inside the effective
  // clip in its unit space, and inside the content in its own.
  if (pointer) {
    const px = pointer.x * dpr, py = pointer.y * dpr;
    for (let i = result.hits.length - 1; i >= 0; i--) {
      const h = result.hits[i];
      if (!insideUnit(h.quad, px, py) || !(h.clip.infinite || insideUnit(h.clip, px, py))) continue;
      g2d.setLineDash([]);
      g2d.strokeStyle = '#ffe066';
      g2d.lineWidth = 2 * dpr;
      outline(h.quad);
      if (!h.clip.infinite) {
        g2d.setLineDash([6 * dpr, 4 * dpr]);
        g2d.strokeStyle = 'rgba(80, 220, 255, 0.95)';
        outline(h.clip);
      }
      g2d.font = `${Math.round(12 * dpr)}px ui-monospace, monospace`;
      g2d.textAlign = 'left';
      g2d.fillStyle = '#ffe066';
      g2d.fillText(h.name, px + 14 * dpr, py - 10 * dpr);
      break;
    }
  }
}

function outline(k) {
  g2d.beginPath();
  g2d.moveTo(k.ox, k.oy);
  g2d.lineTo(k.ox + k.k0x, k.oy + k.k0y);
  g2d.lineTo(k.ox + k.k0x + k.k1x, k.oy + k.k0y + k.k1y);
  g2d.lineTo(k.ox + k.k1x, k.oy + k.k1y);
  g2d.closePath();
  g2d.stroke();
}

// ---------------------------------------------------------------- controls

for (const key of ['animate', 'smooth', 'surplus', 'outlines', 'mixed']) {
  const el = document.getElementById(key);
  el.checked = settings[key];
  el.addEventListener('change', () => { settings[key] = el.checked; });
}
const depthEl = document.getElementById('depth');
const depthVal = document.getElementById('depthVal');
depthEl.value = settings.depth;
depthVal.textContent = settings.depth;
depthEl.addEventListener('input', () => {
  settings.depth = Number(depthEl.value);
  depthVal.textContent = settings.depth;
  root = makeScene();
});

glCanvas.addEventListener('pointermove', (e) => { pointer = { x: e.clientX, y: e.clientY }; });
glCanvas.addEventListener('pointerleave', () => { pointer = null; });

requestAnimationFrame(frame);
