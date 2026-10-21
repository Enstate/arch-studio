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
  Studio asks once per project and dependency set (`package.json`, lockfile and
  build entry). Rounds and builds reuse that grant until it is revoked or one of
  those files changes. Never grant it implicitly.
- Studio runs Claude Code or Codex through `packages/agent`, a port of t3code's
  adapters. Agents use the user's own local logins. Studio never holds API keys.
  Request rounds run with full access, the user's explicit choice: no sandbox and
  no approval prompts. Critique rounds stay read-only. Studio keeps copies of the
  images an agent views so the timeline can show them.
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
loopback Studio, with no cloud login. Open the token-bearing launcher URL from
the terminal. Studio exchanges its fragment token for a bearer held in
origin-scoped sessionStorage and clears the fragment. Server functions require
its custom request header. Never replace this with host-scoped cookies, which
leak to other loopback ports. Bare-origin requests cannot create a session.
Artifact and reference downloads require signed capability URLs and strict
request-origin checks.

Typecheck through the root `check-types` scripts, which own the checker choice.
Run `bun run check-types:<project>` for the project you changed and its known
consumers: `scripts`, `studio`, `agent`, `project`, `project-tools`, `ui`,
`viewer` or `viewer-ui`. `bun run check-types` runs every project, as CI does.
It fails when a tsconfig project has no `check-types:<project>` script, so add
one with each new project.
Public package consumers include Studio and the separately released hosted app.
Use focused tests under `packages/project-tools/tests` for integrity changes.
`bun run verify:standalone` exercises the actual Studio and checkpoint boundary;
follow its printed prerequisites and stop processes you start. Keep captures in
ignored `evidence/`. Run builds and broad checks through the workstation's shared
verification guard when it is installed. CI runs exhaustive public checks.

For macOS shell changes, build Studio, create a local `--preview` app with
`bun scripts/desktop-package.ts --preview --version 0.0.0 --phase app`, then run
`bun scripts/verify-desktop-sidebar.ts`. This harness pairs a native Electron
window with its own temporary synthetic store, checks its sidebar and IPC
boundaries, saves loaded evidence, and closes its app and server. Use the shared
verification guard for these commands. A local preview is never a public release.

The hosted platform consumes archives from GitHub Releases. Update package source
here, verify the packed consumer, then release and update the private lockfile.
Never patch a second copy of a public package in the private application.
