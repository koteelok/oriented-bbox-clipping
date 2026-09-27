// One instanced draw for every sprite, whatever its clip.
//
// The vertex shader moves the content into its clip's space, where the clip is
// [0,1]², and does there exactly what the axis-aligned renderer does in screen
// space:
//
//   - content parallel to the clip: clamp its own four corners. Clamping the
//     corners of one axis-aligned rect to another IS their intersection, so the
//     geometry is exact and the fragment shader tests nothing.
//   - content rotated against the clip, and it would clamp: emit its BOUNDING
//     BOX instead (axis-aligned, so it clamps exactly) and let the fragment
//     shader trim the surplus back to the content rect via vLocal.
//
// Then the clamped corner goes back to world space through the clip's columns.
// The clip's edges are always real geometry and get MSAA; only a rotated
// content's own edges, and only when clipped, are cut per fragment.

const VS = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec4 iXform;      // content columns c0, c1, world px
layout(location = 1) in vec2 iOrigin;
layout(location = 2) in vec4 iClipXform;  // clip columns k0, k1: unit square -> world
layout(location = 3) in vec2 iClipOrigin;
layout(location = 4) in vec4 iUV;         // u0, v0, u1, v1
layout(location = 5) in vec4 iTint;       // straight alpha
layout(location = 6) in float iAligned;   // content edges parallel to the clip's (CPU-decided)

uniform vec2 uResolution;

out vec2 vLocal;
out vec4 vTint;
flat out vec4 vUVRect;
flat out float vBoxed;

// Same strip order as tnt-sandbox: it puts the internal edge on (0,0)-(1,1).
const vec2 corners[4] = vec2[4](vec2(0.0, 1.0), vec2(0.0, 0.0), vec2(1.0, 1.0), vec2(1.0, 0.0));

void main() {
  // Read once, at the top of main(): reading it inside a function crashes
  // Firefox's ANGLE/D3D11 backend.
  int vid = gl_VertexID;
  vec2 corner = corners[vid];

  mat2 C = mat2(iXform.xy, iXform.zw);
  mat2 K = mat2(iClipXform.xy, iClipXform.zw);
  mat2 Ki = inverse(K);

  // The content in clip space.
  mat2 R = Ki * C;
  vec2 ro = Ki * (iOrigin - iClipOrigin);

  // Its box there: extent |r0| + |r1| per axis, low corner the origin plus
  // whichever columns point backwards.
  vec2 ext = abs(R[0]) + abs(R[1]);
  vec2 lo = ro + min(R[0], vec2(0.0)) + min(R[1], vec2(0.0));
  bool clamps = any(lessThan(lo, vec2(0.0))) || any(greaterThan(lo + ext, vec2(1.0)));
  bool boxed = iAligned < 0.5 && clamps;

  vec2 p = boxed ? lo + ext * corner : ro + R * corner;
  vec2 q = clamp(p, 0.0, 1.0);

  // A corner the clip did not touch keeps its exact world position and local
  // coordinate rather than a round trip through K and back: adjacent quads
  // then share bit-identical edges, and vLocal is exactly 0 or 1 on them.
  bool moved = boxed || any(notEqual(p, q));
  vec2 world = moved ? iClipOrigin + K * q : iOrigin + C * corner;
  vLocal = moved ? inverse(R) * (q - ro) : corner;

  vTint = iTint;
  vUVRect = iUV;
  vBoxed = float(boxed);

  vec2 ndc = world / uResolution * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
}
`;

// The atlas is premultiplied, the tint straight. Only a boxed quad is ever
// trimmed, and it is a multiply, not a branch: the flag is per instance, so a
// branch would diverge inside one draw. `uv` samples the clamped local
// coordinate so the surplus never reads a neighbouring tile.
//
// uSmooth picks the trim edge: `step` is a hard cut (aliased, since MSAA runs
// the fragment shader per pixel, not per sample), the fwidth ramp is a
// half-pixel coverage estimate that matches the MSAA'd edges of an unclipped
// rotated sprite.
const FS = /* glsl */ `#version 300 es
precision highp float;

in vec2 vLocal;
in vec4 vTint;
flat in vec4 vUVRect;
flat in float vBoxed;

uniform sampler2D uAtlas;
uniform float uSmooth;
uniform float uSurplus;

out vec4 fragColor;

void main() {
  vec2 uv = mix(vUVRect.xy, vUVRect.zw, clamp(vLocal, 0.0, 1.0));
  vec4 texel = texture(uAtlas, uv);

  vec2 hard = step(0.0, vLocal) * step(vLocal, vec2(1.0));
  vec2 soft = clamp(min(vLocal, 1.0 - vLocal) / fwidth(vLocal) + 0.5, 0.0, 1.0);
  vec2 inside = mix(hard, soft, uSmooth);
  float cov = mix(1.0, inside.x * inside.y, vBoxed);

  vec4 color = texel * vec4(vTint.rgb * vTint.a, vTint.a) * cov;
  fragColor = color + (1.0 - cov) * vBoxed * uSurplus * vec4(0.45, 0.04, 0.06, 0.45);
}
`;

// 72-byte instance record: 16 floats, then tint (4 x u8) and the aligned flag.
const STRIDE = 72;
const FLOATS = STRIDE / 4;
const BYTE_TINT = 64;

const ATTRS = [
  { loc: 0, size: 4, type: 'FLOAT', norm: false, off: 0 },
  { loc: 1, size: 2, type: 'FLOAT', norm: false, off: 16 },
  { loc: 2, size: 4, type: 'FLOAT', norm: false, off: 24 },
  { loc: 3, size: 2, type: 'FLOAT', norm: false, off: 40 },
  { loc: 4, size: 4, type: 'FLOAT', norm: false, off: 48 },
  { loc: 5, size: 4, type: 'UNSIGNED_BYTE', norm: true, off: BYTE_TINT },
  { loc: 6, size: 1, type: 'UNSIGNED_BYTE', norm: false, off: BYTE_TINT + 4 },
];

export class SpriteBatch {
  constructor(gl, texture, capacity = 512) {
    this.gl = gl;
    this.texture = texture;
    this.program = link(gl, VS, FS);
    this.uniforms = {
      resolution: gl.getUniformLocation(this.program, 'uResolution'),
      atlas: gl.getUniformLocation(this.program, 'uAtlas'),
      smooth: gl.getUniformLocation(this.program, 'uSmooth'),
      surplus: gl.getUniformLocation(this.program, 'uSurplus'),
    };

    this.vbo = gl.createBuffer();
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    for (const a of ATTRS) {
      gl.enableVertexAttribArray(a.loc);
      gl.vertexAttribPointer(a.loc, a.size, gl[a.type], a.norm, STRIDE, a.off);
      gl.vertexAttribDivisor(a.loc, 1);
    }
    gl.bindVertexArray(null);

    this.count = 0;
    this.allocate(capacity);
  }

  allocate(capacity) {
    const old = this.u8;
    this.capacity = capacity;
    this.bytes = new ArrayBuffer(capacity * STRIDE);
    this.f32 = new Float32Array(this.bytes);
    this.u8 = new Uint8Array(this.bytes);
    if (old) this.u8.set(old);
  }

  begin() {
    this.count = 0;
  }

  push(c0x, c0y, c1x, c1y, ox, oy, clip, uv, tint, aligned) {
    if (this.count === this.capacity) this.allocate(this.capacity * 2);
    const f = this.f32, i = this.count * FLOATS;
    f[i] = c0x; f[i + 1] = c0y; f[i + 2] = c1x; f[i + 3] = c1y;
    f[i + 4] = ox; f[i + 5] = oy;
    f[i + 6] = clip.k0x; f[i + 7] = clip.k0y; f[i + 8] = clip.k1x; f[i + 9] = clip.k1y;
    f[i + 10] = clip.ox; f[i + 11] = clip.oy;
    f[i + 12] = uv[0]; f[i + 13] = uv[1]; f[i + 14] = uv[2]; f[i + 15] = uv[3];
    const b = this.count * STRIDE + BYTE_TINT, u = this.u8;
    u[b] = tint[0]; u[b + 1] = tint[1]; u[b + 2] = tint[2]; u[b + 3] = tint[3];
    u[b + 4] = aligned ? 1 : 0;
    this.count++;
  }

  flush(width, height, { smooth, surplus }) {
    const gl = this.gl;
    if (this.count === 0) return;
    gl.useProgram(this.program);
    gl.uniform2f(this.uniforms.resolution, width, height);
    gl.uniform1i(this.uniforms.atlas, 0);
    gl.uniform1f(this.uniforms.smooth, smooth ? 1 : 0);
    gl.uniform1f(this.uniforms.surplus, surplus ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.u8.subarray(0, this.count * STRIDE), gl.DYNAMIC_DRAW);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    gl.bindVertexArray(null);
  }
}

function link(gl, vs, fs) {
  const program = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(program, s);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  return program;
}
