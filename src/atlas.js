// A 256² atlas of four procedural tiles in 128 px cells with a 4 px gutter.
// Uploaded premultiplied, which is what the fragment shader assumes.

export const TILE = { WHITE: 0, CHECKER: 1, DISC: 2, STRIPES: 3 };

const SIZE = 256, CELL = 128, GUTTER = 4;

export function createAtlas(gl) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const g = canvas.getContext('2d');

  const uvs = [white, checker, disc, stripes].map((paint, i) => {
    const x = (i % 2) * CELL + GUTTER, y = (i >> 1) * CELL + GUTTER, s = CELL - 2 * GUTTER;
    g.save();
    g.translate(x, y);
    g.beginPath();
    g.rect(0, 0, s, s);
    g.clip();
    paint(g, s);
    g.restore();
    // Inset half a texel so bilinear filtering never reaches the gutter.
    return [(x + 0.5) / SIZE, (y + 0.5) / SIZE, (x + s - 0.5) / SIZE, (y + s - 0.5) / SIZE];
  });

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return { texture, uvs };
}

function white(g, s) {
  g.fillStyle = '#fff';
  g.fillRect(0, 0, s, s);
}

// Asymmetric on purpose — the corner marker shows which way the texture faces.
function checker(g, s) {
  const n = 8, q = s / n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      g.fillStyle = (x + y) % 2 ? '#8792c4' : '#e9ecf7';
      g.fillRect(x * q, y * q, q, q);
    }
  }
  g.lineWidth = 6;
  g.strokeStyle = '#ffcf4a';
  g.strokeRect(3, 3, s - 6, s - 6);
  g.fillStyle = '#ff5d73';
  g.beginPath();
  g.moveTo(6, 6);
  g.lineTo(6 + s * 0.35, 6);
  g.lineTo(6, 6 + s * 0.35);
  g.fill();
}

function disc(g, s) {
  const c = s / 2, r = c - 3;
  const grad = g.createRadialGradient(c * 0.7, c * 0.7, 2, c, c, r);
  grad.addColorStop(0, '#9be9ff');
  grad.addColorStop(1, '#2f7bd6');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(c, c, r, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#fff';
  g.beginPath();
  g.moveTo(c, c);
  g.arc(c, c, r * 0.8, -0.35, 0.35);
  g.closePath();
  g.fill();
}

function stripes(g, s) {
  const grad = g.createLinearGradient(0, 0, s, s);
  grad.addColorStop(0, '#fff');
  grad.addColorStop(1, '#b9bfd6');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  g.strokeStyle = 'rgba(40, 44, 60, 0.35)';
  g.lineWidth = 8;
  for (let i = -s; i < 2 * s; i += 20) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i + s, s);
    g.stroke();
  }
}
