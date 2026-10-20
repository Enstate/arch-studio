# Arch Studio

This is the public local authoring application. Enstate's hosted customer platform
lives in a separate private repository and consumes released packages from here.
Keep this repository independently runnable without accounts or cloud credentials.

## Boundaries

- Agents edit a project's source and assets. The local artifact build validates
  the result, saves immutable bytes and a checkpoint, and the shared viewer shows it.
- Project IDs and checkpoint IDs are portable. Hosted database IDs, accounts,
  customer approvals and publication authority stay in the hosted platform.
- Local notes are private project context. They never constitute hosted approval.
- Keep customer sources, references, stores, credentials and evidence outside Git.
  Use synthetic inputs for verification. The sample house is only a demo fixture.
- The source build is explicit local code execution, bounded but not sandboxed.
  Retain the execution confirmation and the loopback/session/origin guards.
- Preserve viewer `src/` and `package.json` byte identity across distribution.
  Both define the runtime hash. The release packer deliberately preserves the
  viewer manifest. A runtime change needs explicit compatibility review.

## Code

Match the existing shared `ProjectLayout`, UI tokens, lazy viewer and DE/EN copy.
Use derived state, event handlers and TanStack Query. Components do not call
`useEffect` or `useLayoutEffect` directly. Read the owning package before edits.

Project authoring uses `.agents/skills/arch-generation`; critique uses
`arch-critique`; portable continuation uses `arch-checkpoint`. New customer work
uses only that project's supplied references. Demo files are not design inputs.

## Verification

`bun install --frozen-lockfile` installs this public checkout. `bun run demo`
creates the synthetic house in the selected local store. `bun dev` starts only
loopback Studio, with no cloud login. There is no account form: an HttpOnly local
session and strict request-origin checks protect the local server.

Run the owning TypeScript config with `bun --check --tsconfig-override <config>`.
Public package consumers include Studio and the separately released hosted app.
Use focused tests under `packages/project-tools/tests` for integrity changes.
`bun run verify:standalone` exercises the actual Studio and checkpoint boundary;
follow its printed prerequisites and stop processes you start. Keep captures in
ignored `evidence/`. Run builds and broad checks through the workstation's shared
verification guard when it is installed. CI runs exhaustive public checks.

The hosted platform consumes archives from GitHub Releases. Update package source
here, verify the packed consumer, then release and update the private lockfile.
Never patch a second copy of a public package in the private application.
