# Arch renderer foundation

`template/` preserves the shared Three.js foundation from the Mediterranean
walkthrough. Project creation copies this foundation into the editable workspace.
Each checkpoint therefore contains its exact runtime source, not a link to a
moving copy. The manifest records the template and Three.js versions.

The copied foundation is a starting point for the first internal milestone. It
is not a general floor-plan parser or a production-quality rendering guarantee.
Fixture-specific geometry and room modules remain under `fixtures/mediterranean`.
Source provenance and outstanding geometry assumptions are in its manifest.

## Copied runtime contract

`template/` is copied into a project workspace. It cannot run by itself. The
project supplies `src/plan.js`, room modules, part modules and local assets.
It currently provides the reference runtime's loaders and rendering behavior;
it does not provide asset discovery or downloading.

`src/plan.js` must export:

- `presentation.title` and `presentation.description`, strings used as text in
  the entry overlay. The title also sets the browser tab title.
- `presentation.start.position` and `presentation.start.target`, three-number
  world-coordinate arrays used for the initial interactive camera.
- `presentation.environment`, a local HDRI path relative to the entry URL.
- `presentation.sunTarget`, a three-number world-coordinate array.
- `presentation.materials.plaster`, `.stucco` and `.floor`, each containing a
  texture `id` and an `options` object passed unchanged to `lib.pbr`.
- `parts`, an array of module names loaded from `src/parts/<name>.js`, or `[]`.
- `pieces`, an array of module names loaded from `src/rooms/<name>.js`.
- `H`, `GROUND`, `EXT`, `rooms`, `walls`, `openings`, `steps`, `roomAt` and
  `views`, the geometry, navigation and fixed-view inputs used by `main.js`
  and `shell.js`. The Mediterranean plan is the current worked example of
  these shapes. Room rectangles carry `owner` and optional `outdoor`; views
  carry `piece`, `pos`, `target` and `fov`.

Every piece and part exports `build(ctx)`. Room pieces may also export
`wallMaterial(ctx, roomId)`. Missing modules, failed builds, tracked asset
failures and unknown requested views prevent readiness. Both interactive and
fixed-view paths set `window.__ready` only after four rendered frames with no
recorded errors. `window.__archHealth` exposes the loading, ready or error
status. A debug preview that skips pieces cannot report ready.

Geometry and project presentation belong to the project. Template revisions
retain their own review and version; copying a runtime does not approve a
project's dimensions, styling or checkpoint.
