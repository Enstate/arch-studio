# Arch Studio

Local architectural visualization by Enstate. Open a project, let your existing
coding agent work on its source, build a version and review it in the browser.
Source, references, notes and checkpoint history stay on your machine.

Studio requires no Enstate account, Convex account or cloud deployment.
Your agent tool uses its own login and network connection. Arch Studio does not
provide model credits or run agents on Enstate servers.

## Start

Install [Bun 1.4.3 or newer](https://bun.sh), then:

```sh
git clone https://github.com/Enstate/arch-studio.git
cd arch-studio
bun install --frozen-lockfile
bun run demo
bun dev
```

Open http://localhost:3101. The demo is a furnished, synthetic sample house with
procedural materials. It needs no downloaded asset library. It is a separate
project and never supplies references for a customer's work.

For a new project, create a client and project in Studio, then choose **Start
from documents**. Give the new project folder to T3 Code, Claude Code, Codex or
your preferred agent. Its `AGENTS.md`, `BUILDERS.md`, source and context travel
with the project. Inspect the source before using **Build and version**. A build
executes code locally with your permissions; its time limit is not a sandbox.

Existing projects can be opened from their folders. Projects registered through
the CLI appear in Studio automatically. New projects start without geometry.
Studio provides preview and project management, not a CAD editor or agent chat.

## Continue on another machine

Choose **Handoff** to export an immutable checkpoint folder. On the other machine,
use **Restore handoff** and select a new destination. References, source, assets,
local review notes and agent context travel together. Restoring preserves the
checkpoint; building a change creates a child version.

For scripts and agents, `bun run arch --help` lists the same local operations.
Use an absolute `ARCH_HOME` to choose a different store. Otherwise Studio and
the CLI share the platform's application-data directory. They never put private
work in Git. Existing checkout-local `.arch` stores can be opened explicitly with
`ARCH_HOME=/absolute/path/to/.arch` or transferred through checkpoint export.

## Hosting

Local builds and exports work independently. Enstate's separately operated
customer platform provides shared review, approvals, hosted releases and
publication. Export a checkpoint, sign in to that service and upload it explicitly.
Local notes and builds do not grant hosted acceptance or publication.

## Packages and assets

This repository owns the viewer, shared UI, portable contracts and local tools.
The private customer platform consumes versioned archives from GitHub Releases.
`bun run release:packages --tag v0.1.0` prepares archives from a committed revision;
it does not publish them. Each release includes checksums and source provenance.

`bun run fetch-assets` optionally downloads the CC0 Poly Haven library into
`apps/studio/public/viewer`. Downloaded assets are excluded from Git. Preserve
the generated `CREDITS.md` when delivering those assets. Imported assets and
customer projects retain their own rights; the code license does not license them.

Code is [MIT licensed](LICENSE). The Enstate name and branding are separate from
the code license.
