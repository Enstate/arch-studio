---
name: arch-generation
description: Generate or revise an Arch project as source, in bounded builder and critic rounds. Projects can be buildings, interiors, public spaces such as plazas, landscapes, sites with terrain, or anything else. Use when organizing or planning a folder of customer documents or survey data, starting a project from them, building from a floor plan or site survey, running or leading a design round, restyling a project, or deciding whether a version is ready for review.
---

# Arch generation

A project is authored as **source**: `source/` holds the generator entry and its modules, `assets/` holds plan inputs, the model library, textures and custom models. The bounded artifact build runs the entry and writes an immutable **artifact** (`outputs/artifact/plan.json` plus everything the plan uses). The shared viewer in `packages/viewer` renders the artifact. Agents edit source; they never edit the artifact, the viewer or an app to change one project.

Customer differences live in project source. One codebase serves every customer: no per-customer copy of the portal, Studio or viewer. Builders run in the user's external coding agent, such as T3 Code, Codex or Claude Code, with that tool's own provider login.

Read the project's root `AGENTS.md` and `BUILDERS.md` first. They travel with the checkpoint and override this skill for that project. `BUILDERS.md` holds the core standards and the guide for the project's kind. Studio rounds and `arch continue` replace them when they are unedited stock rules from an older Studio or for another kind, so a project picks up current guidance; edited rules stay as written. Your design inputs are that project's `reference/` files and brief. When you need a plan type or rule, read `packages/viewer/src/plan/schema.ts` and `validate.ts`; other projects and `fixtures/` are not inputs.

## Starting

- **Documents folder, no project yet:** `bun run arch init <documents-folder> <new-folder> --id <project-id> --name <name> --client-id <workspace-slug> --client-name <name>`. The starter holds the references, rules and plan v1 guidance, with no geometry and no render. Its first step is a written geometry and style brief from the references.
- **Existing project folder on this machine:** `bun run arch continue <project-folder>`, then read the brief it prints.
- **Bundle from another machine:** follow `arch-checkpoint`.

For a new project, or while `source/intake.json` still lists `unresolved` documents, do intake: read [references/intake.md](references/intake.md) to classify every page into `source/intake.json` and plan the pieces. When the user asked only to plan or organize, stop after intake. Planning does not authorize building, and no session publishes on its own.

`client.id` must equal the Studio client's key. Start from documents or Open attaches a folder to a Studio project. Sources registered through the CLI appear in Studio automatically.

## Which runtime

Check `schemaVersion` in `arch.project.json`.

- `2`: a viewer project. Follow this skill.
- `1`: a **legacy snapshot** on template 0.1.0 (`src/plan.js`, `src/rooms/`, `src/parts/`). Edit it only under the template contract in `packages/renderer/README.md`, preview it in its own isolated origin, and leave it as a legacy project. Moving it to the viewer is a separate authoring job the lead asks for: write new viewer source from the references and the old views. Nothing converts it automatically.

## Project facts and kinds

`facts` in `arch.project.json` are what the user confirmed in Studio: `kind`, `location` (label, latitude, longitude), `storeyHeight` in metres and `north` in degrees clockwise from the top of the plan. Build on them as given. Never re-derive or overwrite them. When a reference contradicts a fact, keep the fact, add an unconfirmed assumption naming the fact and the reference, and ask the user. The build writes `location.latitude` and `north` into the artifact's plan, so the sun follows the real site.

The kind picks the guide `BUILDERS.md` carries. Read the one that fits:

| `facts.kind` | Guide |
| --- | --- |
| `building` | [references/building.md](references/building.md): storeys, stairs, roofs and sloped ceilings |
| `interior` | [references/interior.md](references/interior.md): a fit-out inside a given shell |
| `public-space` | [references/public-space.md](references/public-space.md): plazas, squares, streets and courtyards |
| `landscape` | [references/landscape.md](references/landscape.md): gardens, parks and planting |
| `site` | [references/site.md](references/site.md): terrain, grading and massing |
| `other` or none | [references/other.md](references/other.md), with whichever guides fit its parts |

## Core standards

These apply to every kind. `BUILDERS.md` has the full text.

- **Scale.** Everything is metres at real size. Scale comes from a printed dimension, a scale bar or survey coordinates. A scale inferred from typical door, car or furniture sizes is a guess: record it as `unconfirmed` and ask before building on it.
- **Bundling.** The artifact holds everything it shows. Asset paths are relative to `plan.json`; no absolute paths, remote URLs or parent traversal. Copy only the library entries the project uses, with their licences and credits.
- **Budgets.** An artifact under 15 MB, under 500,000 triangles per look in walk mode, under 40,000 per piece and 20,000 per person, and embedded WebP at 1024 px or less. Every copy of a repeated model counts.
- **Dependencies.** The build accepts exactly one package, `three@0.186.1`, under `dependencies` in `package.json` and pinned in the lockfile. Nothing else is installed, and a project that lists any other package fails before its generator runs. Write noise, terrain grids, geometry and GLB files by hand in `source/`: a seeded mulberry32 generator with value noise, inverse-distance weighting onto a height grid, typed arrays for positions, normals and indices, and a GLB writer of about 60 lines. `BUILDERS.md` "Dependencies" has the details.
- **Models.** Leave models uncompressed; the build meshopt-compresses them. It rejects Draco (`KHR_draco_mesh_compression`) and Basis/KTX2 (`KHR_texture_basisu`) models: export those again as plain GLB with PNG, JPEG or WebP textures.
- **Verification.** Validation errors fail the build; warnings are building heuristics, so fix those that apply to the project's kind. A plan that validates still needs critique of rendered views against the references.

## Before the first round

The lead fixes these before any builder starts. Each ends when it is written in `arch.project.json`, `source/intake.json` or the base plan under `assets/`.

1. **References.** Every input the customer actually supplied, under `references`. Nothing else is a reference. Survey data (DXF, CSV, GeoJSON) is read, never executed.
2. **Geometry.** Everything follows the customer-approved drawings or survey: walls, openings and door swings for a building, extents, levels and routes for open ground. Any missing dimension and any departure from the drawings is an assumption with status `unconfirmed`. Door swings stay as drawn, whatever a camera or walking route would prefer.
3. **Levels.** Every storey or terrace goes in one plan, listed in `levels` and named by the elements on it. Stairs join storeys as `stairs` flights. The kind's guide has the rules, including how to convert a building that fakes an upper storey.
4. **Views.** Fixed cameras, each owned by one piece. Moving one is a lead decision.
5. **Design options.** When the brief asks for several looks, they are `designOptions` over one layout, each its own piece with its own builder and critique; see `BUILDERS.md`, "Design options". A different layout is a variant, not an option.
6. **Ownership.** One builder per piece. A piece is usually a room, a zone of a site or an authored object, with its own modules under `source/` and its own files under `assets/`. Shared source (the entry, the base plan, the ground, shared materials) has one named owner. The viewer, renderer and apps belong to no piece.

## A round

1. Start a fresh builder per piece with the round number, the brief, the previous critique for that piece, and the comments on the current version. The builder starts on the critique's strongest gap.
2. The builder edits only its own source and assets. A needed shared change, including any to the viewer or renderer, goes in its report as a request; the builder works around it.
3. Run the artifact build: `bun run arch build <project-id> --authorize-source-execution` or Build in the Studio. It needs explicit authorization, stops after 30 seconds, and receives a restricted environment. It executes with the local user's permissions and is not a sandbox. A build that fails, times out, writes no `plan.json`, references an asset outside the artifact or produces an invalid plan ends the round for that piece. The build saves a checkpoint; record its ID and the artifact hash.
4. Preview that exact checkpoint's artifact in the viewer and render the piece's views one at a time. Only a finished build's checkpoint is previewed, never a folder a builder is still writing. Look at every image. A view counts only when the preview loaded with no error and no request left the artifact origin.
5. Start a fresh critic with `arch-critique`, separate from the piece's builder. Its report goes in `outputs/critique/round-<n>.md`.
6. Compare with the best round. Keep the better one. When the round is worse, restore the best round's checkpoint before the next round. Reconcile any newer user decisions, intake classifications and assumptions after restoring, then save a checkpoint before resuming.

Stop after six rounds, or earlier when the critic finds nothing material and the lead agrees. Report every unresolved issue by piece.

## Styling and models

Styling is creative within the customer's brief and lives in source: material colours, roughness, PBR choices, furniture and planting placement, textiles, lighting, decor, custom models. Style comes from the brief or the user, never from a default. It stays inside the drawn layout: arches, rooflines, openings, paths and terraces appear only where the drawings show them. Keep everything at real dimensions, walking paths and doorways clear, nothing through walls or the ground, door swings and sills respected. Use the lowest texture resolution that holds up in the fixed views; heavy texture sets have crashed preview GPUs. The shared CC0 library (textures, furniture models, skies) is `apps/studio/public/viewer/library` after `bun run fetch-assets`, with `index.json` and `CREDITS.md`; imported NVIDIA SimReady props (CC BY 4.0) live in the store's `library/`. Studio rounds are told both paths and get the `arch` MCP tools, which search both and SimReady online, import SimReady assets, copy what a project uses into its `assets/library/` with credits, and check placements against the last build. Copy only the entries a project uses.

When the brief asks for Mediterranean, that usually means warm off-white plaster, natural wood and stone, terracotta and olive accents, and layered textiles, lighting and decor where the room calls for them.

Set furniture.fixture in the authored plan when visibility should override the type default: true keeps a built-in visible when loose furniture is hidden; false hides it. Set it explicitly for custom built-ins and lighting. This applies to procedural pieces and custom GLBs; filenames do not determine fixture status.

A custom model is generated or copied into the artifact by the generator. A GLB embeds its buffers and textures, so the artifact stays self-contained. Use only assets whose licence allows delivery in a web player and record credits in the project. Generated models blow the budget first: full-resolution character meshes, dense scans and trees, terrain grids finer than anyone sees, and the same fabric texture embedded in every sofa are the usual causes, so simplify and resize in the generator, not by hand.

The viewer is a shared runtime. A change to `packages/viewer/src` or its `package.json` changes the runtime hash, and existing artifacts stop previewing until their pinned runtime is restored. That change is its own reviewed change, never part of a project round.

## Hand edits

People can move, turn, remove and place furniture and paint surfaces by hand in Studio's viewer. Studio saves those changes in `source/edits.json`, and every build lays them over the plan the generator writes, so hand edits win over source. Read the file before a round and keep its intent; never change it unless the request asks to adopt the hand edits. Adopting folds every edit into source, including `Room.wallFinishes`, `Wall.outsideFinish` and the `paint-<n>` materials, then writes `{"version":1}` to the file and rebuilds. Edits whose piece, room or wall is gone are listed in `outputs/artifact/hand-edits.json`; carry their intent over where it makes sense. The project's `BUILDERS.md`, "Hand edits", has the file format and surface IDs.

## Ready for review

A version is ready for review when all of these hold:

- The latest artifact build succeeded and its checkpoint passes artifact inspection.
- The artifact's runtime hash matches the installed viewer.
- Every fixed view rendered from that checkpoint without errors or outside requests, once per design option when the plan has them.
- The checks in the kind's guide pass. For a building with several storeys: no stair warnings, each storey right in the floor picker in plan, 3D and walk, every flight climbable, and pitched roofs as `roof: true` pieces over `ceilingSlope` ceilings. For open ground: the ground is continuous, walk mode crosses the terrain and climbs every step and ramp, and the extents match the survey.
- Each design option is within the budgets, checked from the artifact's file sizes and GLB triangle counts.
- Every assumption is listed with its status, and no confirmed fact was changed.
- The latest critique and the unresolved list are saved in the project.
- `arch.context.json` names the next action.

Then save with `arch-checkpoint` and report the checkpoint ID, artifact hash and runtime hash, saying it meets these conditions. Studio provides local review and handoff. Upload, acceptance and publication belong to Enstate's separate hosted platform. A critic score grants no acceptance.
