# Oriented bbox clipping

Batched clipping of rotated content against rotated clip rects, in one instanced draw call. No stencil, no scissor, no mask textures.

## The approach

Every clip is stored as the affine transform that maps the unit square onto it. In the clip's local space the clip is `[0,1]²`, whatever rotation, scale or skew put it on screen.

In the vertex shader:

1. Move the content into the clip's local space (multiply by the clip's inverse).
2. Take the content's bounding box there and clamp its corners to `[0,1]²`. Clamping one box to another in the same basis gives their exact intersection.
3. Transform the clamped quad back to screen space with the clip's transform and emit it.

In the fragment shader, discard anything outside `[0,1]²` in the content's own local coordinates. The interpolated local coordinates are affine, so the test is exact.

If the content is parallel to the clip (0° or 90° steps), step 2 clamps the content's real corners instead of its box and nothing is discarded. The CPU sets this `aligned` flag, because the shader can't tell reliably through float rounding. The bounding box is also only used when it actually crosses the clip. Rotated content that fits keeps its own geometry.

The result:

- The clip's edges are always real geometry and get MSAA.
- Only a rotated content's own edges, and only when it's clipped, are cut per fragment. Optionally that cut is an `fwidth` coverage ramp for anti-aliasing.

## Nested clips

A clip pushed inside a parallel parent (same rotation, or 90° steps) is an axis-aligned rect in the parent's local space. The CPU intersects the two into one rect, so a chain of any depth collapses to a single clip and the shader never sees more than one.

A clip at any other angle to its parent throws an error. The intersection would be a convex polygon, which one transformed rect can't represent.

## Demo

```sh
npm install
npm run dev
```

There are three scenes:

- **Scroll view:** a rotating card with a nested scroll view.
- **Deep nest:** up to 40 nested clips, every fourth one turned 90°.
- **Skewed parent:** the clip is a parallelogram.

Toggles in the panel show the trimmed surplus and the effective clips. Every setting can also be set from the URL, e.g. `?t=4.3&animate=0&surplus&outlines&depth=40&mixed`.

| File | Contents |
| --- | --- |
| `src/batch.js` | Shaders and the instance buffer |
| `src/nodes.js` | Scene nodes, clip merging, the `aligned` flag, culling |
| `src/main.js` | Scenes, loop, overlay, controls |
| `src/atlas.js` | Procedural texture atlas |
| `src/affine.js` | 2D affine helpers |

## GitHub Pages

In the repository's **Settings → Pages**, set **Source** to **GitHub Actions**.
The workflow in `.github/workflows/pages.yml` builds and deploys the demo on
pushes to `main`, or manually from the Actions tab. If the default branch has a
different name, update the workflow's branch filter.

The build uses the base path reported by GitHub Pages so assets work under the
repository URL or a custom domain. To build locally, run `npm run build`; output
goes to `dist/`.
