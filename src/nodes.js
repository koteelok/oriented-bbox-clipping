// Scene nodes and the build pass that turns them into batch instances.
//
// A CLIP IS A PARALLELOGRAM, stored as the affine map that takes the unit
// square onto it in world space: columns k0, k1 and origin o. In that space
// ("clip space") every clip is exactly [0,1]², so clamping to it is
// clamp(p, 0, 1) — whatever rotation, scale or skew put it on screen.
//
// NESTED CLIPS COLLAPSE ON THE CPU. When a clip is pushed inside another whose
// edges are parallel to its own (same rotation, or any multiple of 90°), it is
// an axis-aligned rect in the parent's clip space, and the intersection of two
// axis-aligned rects is one more axis-aligned rect. So the effective clip stays
// ONE parallelogram, in the OUTERMOST clip's basis, however deep the chain
// goes, and the shader never learns there was more than one. A clip in any
// other basis throws: the intersection would be a polygon, and that is step 2.

import { compose, multiply } from './affine.js';

// Edges count as parallel when the far end of one strays less than this many
// device pixels off the other's line. That bounds the error of treating them
// as parallel by the same amount, and it absorbs the rounding that makes
// cos(π/2) not quite 0 or a +θ/-θ pair not quite cancel.
const PARALLEL_TOL = 1 / 16;

// A clip so large nothing reaches its edges. The vertex shader never moves a
// corner against it, so its size costs no precision.
export const NO_CLIP = Object.freeze({
  k0x: 131072, k0y: 0, k1x: 0, k1y: 131072, ox: -65536, oy: -65536,
  infinite: true, depth: 0,
});

export class ClipBasisError extends Error {
  constructor(message) { super(message); this.name = 'ClipBasisError'; }
}

class Node {
  constructor(o = {}) {
    this.name = o.name ?? '';
    this.x = o.x ?? 0;
    this.y = o.y ?? 0;
    this.rotation = o.rotation ?? 0;
    this.scaleX = o.scaleX ?? 1;
    this.scaleY = o.scaleY ?? 1;
    this.pivotX = o.pivotX ?? 0;
    this.pivotY = o.pivotY ?? 0;
    this.animate = o.animate ?? null;
  }

  local() {
    return compose(this.x, this.y, this.rotation, this.scaleX, this.scaleY, this.pivotX, this.pivotY);
  }
}

/** `clip` is a rect { x, y, w, h } in this container's own coordinates; it
 *  applies to the children. */
export class Container extends Node {
  constructor(o = {}) {
    super(o);
    this.clip = o.clip ?? null;
    this.children = [];
  }

  add(...nodes) {
    this.children.push(...nodes);
    return this;
  }
}

/** Draws the rect (0, 0, w, h) in its own coordinates with one atlas tile. */
export class Sprite extends Node {
  constructor(o = {}) {
    super(o);
    this.w = o.w ?? 0;
    this.h = o.h ?? 0;
    this.tile = o.tile ?? 0;
    this.tint = o.tint ?? [255, 255, 255, 255];
  }
}

export function buildFrame(root, batch, view, t, uvs) {
  const ctx = {
    batch, t, uvs,
    clips: [],
    hits: [],
    stats: { sprites: 0, boxed: 0, culled: 0, clips: 0, merged: 0, empty: 0, maxDepth: 0 },
  };
  visit(root, view, NO_CLIP, ctx);
  return ctx;
}

function visit(node, parentWorld, clip, ctx) {
  if (node.animate) node.animate(node, ctx.t);
  const w = multiply(parentWorld, node.local());

  if (node instanceof Sprite) {
    emit(node, w, clip, ctx);
    return;
  }

  let c = clip;
  if (node.clip) {
    const r = node.clip;
    const raw = {
      k0x: w.a * r.w, k0y: w.b * r.w,
      k1x: w.c * r.h, k1y: w.d * r.h,
      ox: w.a * r.x + w.c * r.y + w.tx,
      oy: w.b * r.x + w.d * r.y + w.ty,
    };
    ctx.stats.clips++;
    if (!clip.infinite) ctx.stats.merged++;
    c = intersect(clip, raw, node.name);
    if (!c) { ctx.stats.empty++; return; }
    ctx.clips.push(c);
    ctx.stats.maxDepth = Math.max(ctx.stats.maxDepth, c.depth);
  }
  for (const child of node.children) visit(child, w, c, ctx);
}

function intersect(parent, raw, name) {
  if (raw.k0x * raw.k1y - raw.k1x * raw.k0y === 0) return null;
  if (parent.infinite) return { ...raw, depth: 1 };

  if (!parallelTo(parent, raw.k0x, raw.k0y, raw.k1x, raw.k1y)) {
    throw new ClipBasisError(
      `"${name}" clips at ${relativeAngle(parent, raw).toFixed(1)}° to the clip it sits in. ` +
      'Step 1 allows one basis per clip chain: nested clips must be parallel or at 90° steps.');
  }

  // Parallel, so `raw` is an axis-aligned rect in the parent's clip space, and
  // its box there IS the rect. Intersect with [0,1]² and map the result back
  // through the parent's own columns, which keeps the parent's basis.
  const b = unitBox(parent, raw.ox, raw.oy, raw.k0x, raw.k0y, raw.k1x, raw.k1y);
  const x0 = Math.max(b.x0, 0), y0 = Math.max(b.y0, 0);
  const x1 = Math.min(b.x1, 1), y1 = Math.min(b.y1, 1);
  if (x1 <= x0 || y1 <= y0) return null;

  const sx = x1 - x0, sy = y1 - y0;
  return {
    k0x: parent.k0x * sx, k0y: parent.k0y * sx,
    k1x: parent.k1x * sy, k1y: parent.k1y * sy,
    ox: parent.ox + parent.k0x * x0 + parent.k1x * y0,
    oy: parent.oy + parent.k0y * x0 + parent.k1y * y0,
    depth: parent.depth + 1,
  };
}

function emit(s, w, clip, ctx) {
  const c0x = w.a * s.w, c0y = w.b * s.w, c1x = w.c * s.h, c1y = w.d * s.h;
  const ox = w.tx, oy = w.ty;
  if (c0x * c1y - c1x * c0y === 0) return;

  // `aligned` is the bit the vertex shader cannot compute reliably itself:
  // Ki * c0 is never exactly axis-aligned after float rounding, even when the
  // tree says it is. Everything else — the box, whether it clamps — the shader
  // derives from the same numbers; this only mirrors it for culling and stats.
  let aligned = true, clamps = false;
  if (!clip.infinite) {
    const b = unitBox(clip, ox, oy, c0x, c0y, c1x, c1y);
    if (b.x1 <= 0 || b.y1 <= 0 || b.x0 >= 1 || b.y0 >= 1) { ctx.stats.culled++; return; }
    aligned = parallelTo(clip, c0x, c0y, c1x, c1y);
    clamps = b.x0 < 0 || b.y0 < 0 || b.x1 > 1 || b.y1 > 1;
  }

  ctx.batch.push(c0x, c0y, c1x, c1y, ox, oy, clip, ctx.uvs[s.tile], s.tint, aligned);
  ctx.stats.sprites++;
  if (!aligned && clamps) ctx.stats.boxed++;
  ctx.hits.push({ name: s.name, quad: { k0x: c0x, k0y: c0y, k1x: c1x, k1y: c1y, ox, oy }, clip });
}

/** A world point in the unit space of parallelogram `k`. */
export function toUnit(k, x, y) {
  const det = k.k0x * k.k1y - k.k1x * k.k0y;
  const dx = x - k.ox, dy = y - k.oy;
  return [(k.k1y * dx - k.k1x * dy) / det, (k.k0x * dy - k.k0y * dx) / det];
}

export function insideUnit(k, x, y) {
  const [u, v] = toUnit(k, x, y);
  return u >= 0 && u <= 1 && v >= 0 && v <= 1;
}

// The box, in k's unit space, of the parallelogram (o; e0, e1). Separable per
// axis — each column contributes to each axis independently — so the low
// corner is the origin plus whichever columns point backwards. The vertex
// shader does the same thing.
function unitBox(k, ox, oy, e0x, e0y, e1x, e1y) {
  const det = k.k0x * k.k1y - k.k1x * k.k0y;
  const ux = (x, y) => (k.k1y * x - k.k1x * y) / det;
  const uy = (x, y) => (k.k0x * y - k.k0y * x) / det;
  const rx = ux(ox - k.ox, oy - k.oy), ry = uy(ox - k.ox, oy - k.oy);
  const ax = ux(e0x, e0y), ay = uy(e0x, e0y);
  const bx = ux(e1x, e1y), by = uy(e1x, e1y);
  const x0 = rx + Math.min(ax, 0) + Math.min(bx, 0);
  const y0 = ry + Math.min(ay, 0) + Math.min(by, 0);
  return { x0, y0, x1: x0 + Math.abs(ax) + Math.abs(bx), y1: y0 + Math.abs(ay) + Math.abs(by) };
}

// How far, in pixels, the end of edge e strays off the line along axis a.
function stray(ex, ey, ax, ay) {
  return Math.abs(ex * ay - ey * ax) / Math.hypot(ax, ay);
}

// Both edges parallel to one of k's columns each. Swapped (a 90° step) counts;
// both parallel to the same column would be a degenerate quad, culled earlier.
function parallelTo(k, e0x, e0y, e1x, e1y) {
  return Math.min(stray(e0x, e0y, k.k0x, k.k0y), stray(e0x, e0y, k.k1x, k.k1y)) <= PARALLEL_TOL
    && Math.min(stray(e1x, e1y, k.k0x, k.k0y), stray(e1x, e1y, k.k1x, k.k1y)) <= PARALLEL_TOL;
}

// For the error message only: the angle to the nearest parent axis, in (-45, 45].
function relativeAngle(parent, raw) {
  const a = (Math.atan2(raw.k0y, raw.k0x) - Math.atan2(parent.k0y, parent.k0x)) * 180 / Math.PI;
  return ((a % 90) + 135) % 90 - 45;
}
