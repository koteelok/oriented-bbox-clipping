// 2D affine transforms: x' = a*x + c*y + tx, y' = b*x + d*y + ty.
// Columns (a, b) and (c, d) are the images of the local x and y axes.

export const IDENTITY = Object.freeze({ a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 });

// translate(x, y) * rotate(rotation) * scale(sx, sy) * translate(-px, -py)
export function compose(x, y, rotation, sx, sy, px, py) {
  const cos = Math.cos(rotation), sin = Math.sin(rotation);
  const a = cos * sx, b = sin * sx, c = -sin * sy, d = cos * sy;
  return { a, b, c, d, tx: x - (a * px + c * py), ty: y - (b * px + d * py) };
}

export function multiply(p, l) {
  return {
    a: p.a * l.a + p.c * l.b,
    b: p.b * l.a + p.d * l.b,
    c: p.a * l.c + p.c * l.d,
    d: p.b * l.c + p.d * l.d,
    tx: p.a * l.tx + p.c * l.ty + p.tx,
    ty: p.b * l.tx + p.d * l.ty + p.ty,
  };
}

export function apply(m, x, y) {
  return [m.a * x + m.c * y + m.tx, m.b * x + m.d * y + m.ty];
}
