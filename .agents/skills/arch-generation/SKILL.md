---
name: arch-generation
description: Generate or revise an Arch project's rooms, furniture, materials and custom models as source, in bounded builder and critic rounds. Use when starting a project from a folder of customer documents, building from a floor plan, running or leading a design round, restyling a project, or deciding whether a version is ready for review.
---

# Arch generation

A project is authored as **source**: `source/` holds the generator entry and its modules, `assets/` holds plan inputs, the model library, textures and custom models. The bounded artifact build runs the entry and writes an immutable **artifact** (`outputs/artifact/plan.json` plus everything the plan uses). The shared viewer in `packages/viewer` renders the artifact. Agents edit source; they never edit the artifact, the viewer or an app to change one project.

Customer differences live in project source. One codebase serves every customer: no per-customer copy of the portal, Studio or viewer, and no hosted model. Builders are Opus 5.5 sessions in T3 Code or Claude Code.

Read the project's root `AGENTS.md` and `BUILDERS.md` first. They travel with the checkpoint and override this skill for that project. Your design inputs are that project's `reference/` files and brief. When you need a plan type or rule, read `packages/viewer/src/plan/schema.ts` and `validate.ts`; other projects and `fixtures/` are not inputs.

## Starting

- **Documents folder, no project yet:** `bun run arch init <documents-folder> <new-folder> --id <project-id> --name <name> --client-id <workspace-slug> --client-name <name>`. The starter holds the references, rules and plan v1 guidance, with no geometry and no render. Its first step is a written geometry and style brief from the references.
- **Existing project folder on this machine:** `bun run arch continue <project-folder>`, then read the brief it prints.
- **Bundle from another machine:** follow `arch-checkpoint`.

`client.id` must equal the Studio client's workspace slug. Before the first version, the project is attached in Studio, through Start from documents or Open on an existing folder.

## Which runtime

Check `schemaVersion` in `arch.project.json`.

- `2`: a viewer project. Follow this skill.
- `1`: a **legacy snapshot** on template 0.1.0 (`src/plan.js`, `src/rooms/`, `src/parts/`). Edit it only under the template contract in `packages/renderer/README.md`, preview it in its own isolated origin, and leave it as a legacy project. Moving it to the viewer is a separate authoring job the lead asks for: write new viewer source from the references and the old views. Nothing converts it automatically.

## Before the first round

The lead fixes these before any builder starts. Each ends when it is written in `arch.project.json` or the base plan under `assets/`.

1. **References.** Every input the customer actually supplied, under `references`. Nothing else is a reference.
2. **Geometry.** Walls, openings and room sizes follow the customer-approved plan. A missing dimension becomes an assumption with status `unconfirmed`. Scale, ceiling height and any change to a door swing are assumptions too.
3. **Views.** Fixed cameras, each owned by one piece. Moving one is a lead decision.
4. **Ownership.** One builder per piece. A piece is usually a room or an authored object, with its own modules under `source/` and its own files under `assets/`. Shared source (the entry, the base plan, shared materials) has one named owner.

## A round

1. Start a fresh builder per piece with the round number, the brief, the previous critique for that piece, and the comments on the current version.
2. The builder edits only its own source and assets. A needed shared change goes in its report as a request; the builder works around it.
3. Run the artifact build: `bun run arch build <project-id> --authorize-source-execution` (pending in the CLI) or Build in the Studio. It needs explicit authorization, stops after 30 seconds, and sees only `PATH` and `ARCH_ARTIFACT_OUTPUT`. A build that fails, times out, writes no `plan.json`, references an asset outside the artifact or produces an invalid plan ends the round for that piece. The build saves a checkpoint; record its ID and the artifact hash.
4. Preview that exact checkpoint's artifact in the viewer and render the piece's views one at a time. Look at every image. A view counts only when the preview loaded with no error and no request left the artifact origin.
5. Start a fresh critic with `arch-critique`. Its report goes in `outputs/critique/round-<n>.md`.
6. Compare with the best round. Keep the better one. When the round is worse, restore the best round's checkpoint before the next round.

Stop after six rounds, or earlier when the critic finds nothing material and the lead agrees. Report every unresolved issue by piece.

## Styling and models

Styling is creative within the customer's brief and lives in source: material colours, roughness, PBR choices, furniture placement, custom models. Keep furniture at real dimensions, walking paths and doorways clear, nothing through walls, door swings and sills respected.

A custom model is generated or copied into the artifact by the generator. A GLB embeds its buffers and textures, so the artifact stays self-contained. Use only assets whose licence allows delivery in a web player and record credits in the project.

The viewer is a shared runtime. A change to `packages/viewer/src` or its `package.json` changes the runtime hash, and existing artifacts stop previewing until their pinned runtime is restored. That change is its own reviewed change, never part of a project round.

## Ready for review

A version is ready for review when all of these hold:

- The latest artifact build succeeded and its checkpoint passes artifact inspection.
- The artifact's runtime hash matches the installed viewer.
- Every fixed view rendered from that checkpoint without errors or outside requests.
- Every geometry assumption is listed with its status.
- The latest critique and the unresolved list are saved in the project.
- `arch.context.json` names the next action.

Then save with `arch-checkpoint` and report the checkpoint ID, artifact hash and runtime hash, saying it meets these conditions. Registering the version and accepting it are staff actions in the Studio. Internal acceptance is a named person's decision; a critic score does not grant it.
