# Intake

Read this when a project starts from a documents folder, when `source/intake.json` has `unresolved` documents, or when the user asks to plan or organize inputs. Intake classifies what the customer supplied, drawings and survey data alike, and plans the pieces. It authors no geometry and starts no model. The facts in `arch.project.json` are confirmed by the user: intake never changes them, and a reference that contradicts one becomes an unresolved question naming the fact.

## The file

`source/intake.json` lives in the source tree and travels with every checkpoint. `arch init` writes it with one `unresolved` page-1 entry per reference file; add an entry for every further page. Studio shows it directly, so a reviewer can read the intake without a model or render. Studio reports invalid intake in the overview without hiding an existing model. Saving or registering the source refuses invalid intake, so run `arch continue` after an intake update and fix what it reports.

```json
{
  "version": 1,
  "brief": "Written geometry and style brief from the references",
  "style": "The style the user or references asked for, in their words, or empty",
  "documents": [{ "id": "a-101-ground", "path": "reference/plans.pdf", "page": 1, "label": "A-101 Ground floor", "level": "ground", "revision": "C", "role": "primary" }],
  "pieces": [{ "id": "ground-living", "label": "Ground floor living", "scope": "Living and dining room", "documentIds": ["a-101-ground"], "dependsOn": [], "status": "planned", "nextAction": "Confirm the overall width with the user" }]
}
```

`path` is a path from `references` in `arch.project.json`. `level` can name several storeys for a composite sheet; piece scopes identify the relevant plan region. `page` is 1-based; a single image is page 1. IDs use lowercase letters, digits and hyphens. The schema in `packages/project/src/intake.ts` holds the limits, such as 1000 document pages. Keep one fact in one place: assumptions stay in `arch.project.json`, and decisions, open questions and the next session's action stay in `arch.context.json`. Intake holds only the classification and the piece plan.

## Classifying

1. Look at every page of every reference. Render each PDF page and read it. A filename or first page tells you nothing about page 7. Keep page renders outside the project; `reference/` keeps the customer's exact bytes, never renamed, converted or re-saved. A survey file (DXF, CSV or GeoJSON) is one document, page 1. Read it as data, never run it, and record its units, coordinate system, height datum and extents in `arch.context.json` decisions.
2. Read the title block of each sheet: project, building or area, level, sheet title, revision, date and scale. Group sheets by what the title blocks say, not by file or folder name.
3. Give each page exactly one document entry with a role:
   - `primary`: the sheet a piece is built from.
   - `supporting`: context such as sections, details, schedules, moodboards or an earlier revision that the title blocks show is superseded.
   - `duplicate`: the same sheet as another page, even under another filename. Verify byte identity or compare rendered pages; identical extracted text alone can miss changed graphics. Set `duplicateOf` to the ID of the page it copies, which is never itself a duplicate, and keep the alias filename in `label`, so the customer's own name for it still resolves.
   - `unresolved`: anything you cannot place yet, with the question in `arch.context.json` unresolved.
4. Tell a duplicate from a revision conflict. Same content is a duplicate. The same sheet with different content is a revision: when the title blocks order the revisions, the latest is `primary` and earlier ones are `supporting`. When they do not, or the content conflicts, both stay `unresolved` and the user picks.

## Levels

Plan v1 stacks storeys and terraces with `levels`, and everything in a project shares one plan. List each storey or terrace in `levels` with its floor elevation and, for a building, its floor-to-floor height, then give each wall, room, furniture piece and camera its `level`. Heights on a level count from its own floor. Draw each flight as one `stairs` piece on its lower level, inside one room, rising to the floor above; the viewer opens the ceiling and floor over it, and walk mode climbs it. Take stair, void, step and ramp positions from the drawings and keep pieces within one level so builders stay bounded. Never flatten a building's storeys into one floor. A building that already fakes an upper storey with raised furniture or a storey-sized model gets one conversion piece, owned by the lead, before other pieces continue. Sloping ground is not a level: it is a `ground: true` terrain model, as the guide for the project's kind describes.

## Done

Intake is done when every reference file and every page has exactly one document entry, every `unresolved` entry has a matching question in `arch.context.json`, and every piece has documents, dependencies, a status and a concrete next action. A piece is `blocked` while a consequential question about it is open and `ready` when its geometry inputs are settled.

Planning ends here. Save the checkpoint with `arch continue` and report it. Authoring the plan or running a round needs the user's request.
