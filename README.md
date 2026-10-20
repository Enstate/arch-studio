# Arch Studio

Local architectural visualization by Enstate. Open a project, let your existing
coding agent work on its source, build a version and review it in the browser.
Source, references, notes and checkpoint history stay on your machine.

Studio requires no Enstate account, Convex account or cloud deployment.
Your agent tool uses its own login and network connection. Arch Studio does not
provide model credits or run agents on Enstate servers.

## Start

On macOS, download the Apple Silicon (`arm64`) or Intel (`x64`) DMG from
[GitHub Releases](https://github.com/Enstate/arch-studio/releases), then drag
Arch Studio into Applications. Installed desktop releases show update status in
the sidebar and under **Arch Studio → Check for Updates**. Choose when to
download and restart; saved projects and checkpoints stay on your machine.
The older v0.1.0–v0.1.2 releases contain source packages only.

To run from source:

Install [Bun 1.4.3 or newer](https://bun.sh), then:

```sh
git clone https://github.com/Enstate/arch-studio.git
cd arch-studio
bun install --frozen-lockfile
bun run demo
bun dev
```

Open the Studio link printed in your terminal. Its per-launch token pairs your
browser with your local Studio and disappears from the address bar after pairing.
The demo is a furnished, synthetic sample house with
procedural materials. It needs no downloaded asset library. It is a separate
project and never supplies references for a customer's work.

For a new project, create a client and project in Studio, then choose **Start
from documents**. Give the new project folder to T3 Code, Claude Code, Codex or
your preferred agent. Its `AGENTS.md`, `BUILDERS.md`, source and context travel
with the project. Inspect the source before using **Build**. A build
executes code locally with your permissions; its time limit is not a sandbox.

Existing projects can be opened from their folders. Projects registered through
the CLI appear in Studio automatically. New projects start without geometry.
Studio provides preview and project management, not a CAD editor or agent chat.

Before modeling, Studio shows a **Project overview** from `source/intake.json`.
Agents use this versioned JSON file to describe the brief, design direction,
individual drawing pages and revisions, duplicate files, and planned pieces with
their dependencies and next actions. New projects start with unreviewed documents.
The agent inspects them before assigning roles or planning geometry. Assumptions
remain in `arch.project.json`; continuation decisions remain in `arch.context.json`.
The overview travels with source checkpoints and does not require executing source
or building a model. Files open inside Studio, with a separate download action.
File labels, revisions and original bytes come from the selected saved version;
the working brief and work plan reflect the current project folder.

For intake and authoring instructions, use
[arch-generation](.agents/skills/arch-generation/SKILL.md).

## Continue on another machine

Choose **Handoff** to export an immutable checkpoint folder. On the other machine,
use **Restore handoff** and select a new destination. References, source, assets,
local review notes and agent context travel together. Restoring preserves the
checkpoint; building a change creates a child version.

For scripts and agents, `bun run arch --help` lists the same local operations.
Use an absolute `ARCH_HOME` to choose a different store. Otherwise the browser
app, installed desktop app and CLI share the platform's application-data directory.
`bun run dev:desktop` uses this checkout's `.arch/dev-store` and
`.arch/desktop-profile` by default. Set `ARCH_HOME` explicitly when using the CLI
with that development app. Private work stays outside Git. Existing checkout-local `.arch` stores can be opened explicitly with
`ARCH_HOME=/absolute/path/to/.arch` or transferred through checkpoint export.

## Hosting

Local builds and exports work independently. Enstate's separately operated
customer platform provides shared review, approvals, hosted releases and
publication. Export a checkpoint, sign in to that service and upload it explicitly.
Local notes and builds do not grant hosted acceptance or publication.

## Packages and assets

This repository owns the viewer, shared UI, portable contracts and local tools.
The private customer platform consumes versioned archives from GitHub Releases.
`bun run release:packages --tag v0.1.0` prepares archives from the matching tag on HEAD;
it does not publish them. Each release includes checksums and source provenance.
The viewer keeps its own package version and exact manifest bytes across tool-only
releases, so existing projects retain their runtime hash.

`bun run fetch-assets` optionally downloads the CC0 Poly Haven library into
`apps/studio/public/viewer`. Downloaded assets are excluded from Git. Preserve
the generated `CREDITS.md` when delivering those assets. Imported assets and
customer projects retain their own rights; the code license does not license them.

Code is [MIT licensed](LICENSE). The Enstate name and branding are separate from
the code license.
