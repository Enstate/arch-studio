# Arch Studio

Local architectural visualization by Enstate. Start a project from its references,
ask Claude Code or Codex for changes in rounds, and review each built version.
Source, references, notes and checkpoint history stay on your machine.

Studio requires no Enstate account, Convex account or cloud deployment.
Studio runs your locally installed Claude Code or Codex with their own logins and
network connections. Arch Studio does not provide model credits or run agents
on Enstate servers.

## Start

On macOS, download the Apple Silicon (`arm64`) or Intel (`x64`) DMG from
[GitHub Releases](https://github.com/Enstate/arch-studio/releases), then drag
Arch Studio into Applications. Installed desktop releases show update status in
the sidebar and under **Arch Studio → Check for Updates**. Choose when to
download and restart; saved projects and checkpoints stay on your machine.
On Windows, run `Arch-Studio-Setup-<version>-windows-x64.exe`. It installs for
the current user and is not code signed yet, so SmartScreen asks you to confirm
the first install. Updates work the same way, with **Check for Updates** in the
window menu.
The older v0.1.0–v0.1.2 releases contain source packages only.

Open **Settings** from the gear in the sidebar or with Cmd/Ctrl+, to change the
language and appearance, and to check Claude Code and Codex under **Agents**. That
page shows whether each one is installed and signed in, with which plan, and gives
the command to install it or sign in when something is missing. On Windows,
npm installs of both CLIs work, and Claude Code also needs
[Git for Windows](https://git-scm.com/downloads/win).

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

For a new project, choose **New project**, name it and drop in its references.
Studio copies them into a project folder it manages and keeps the originals
unchanged. A client is optional. Work then happens in **Rounds**: describe a
change, attach marked-up renders if useful, and pick Claude Code or Codex. The
agent works in the project folder with your existing local login. Studio then
builds the project and saves a version. Studio asks once per project before it
executes project source; a build runs code locally with your permissions, and
its time limit is not a sandbox. Request rounds run with full access: the agent
can run any command, read anything and reach the network without asking, so start
rounds only on projects you trust. Critique rounds are read-only. Images the agent
looks at appear in the timeline as it works. A branch keeps the agent it started
with; start a new branch to try the other one.

Every round's version keeps its request, attachments and agent summary. Use
**Continue from here** on any version to start a branch, so several variants can
run side by side. **Compare** shows two versions with linked cameras, the plan
elements that changed and the changed files. The primary branch is what the
project shows and exports. Agents can still work on the folder from outside
Studio; build there and the version appears in the timeline.

Existing projects can be opened from their folders. Projects registered through
the CLI appear in Studio automatically. New projects start without geometry.
Studio is not a CAD editor.

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

## Furnishing and the asset catalog

Choose **Edit** on the latest version to change the design by hand. **In the room** lists what
stands in the room on show, or on the whole floor: pick a room from the menu or click its name in
the view, then select a piece to turn, duplicate or remove it. **Add** shows the library with
pictures, sorted into categories and searchable. Click a piece to put it in the room on show, or
drag it into place. **Save changes** builds a new version and copies the models it uses into the
project with their credits.

The library is the CC0 Poly Haven set from `bun run fetch-assets` plus any NVIDIA
[SimReady](https://huggingface.co/datasets/nvidia/simready-assets) assets you add. Under
**NVIDIA SimReady** in the Add tray, search the
[SimReady Central](https://huggingface.co/spaces/nvidia/simready-central) catalog and add a result
to your library. Studio reaches Hugging Face only when you search or add. It converts the asset's
OpenUSD into a glTF at real size and keeps it in the store's `library/` folder, outside every
project, for all projects on this machine. SimReady assets are licensed CC BY 4.0: their credit
lines travel into each project's `assets/library/CREDITS.md`, so keep that file with deliveries.

Agents get the same catalog as MCP tools. In a request round Studio gives Claude Code or Codex an
`arch` server for that round only, with `search_catalog`, `import_simready_asset`,
`add_assets_to_project`, `describe_rooms`, `list_furniture`, `find_spot` and `check_placement`.
The furniture tools read the last build and check placements against walls, door swings, windows
and other furniture as the hand editor does. Outside Studio, serve them from a checkout:

```sh
claude mcp add arch -- bun run --cwd /path/to/arch-studio arch mcp --project /path/to/project
codex mcp add arch -- bun run --cwd /path/to/arch-studio arch mcp --project /path/to/project
```

`bun run arch catalog search <words>` and `bun run arch catalog import <simready-asset>` do the same
from a terminal.

## Continue on another machine

Choose **Handoff** to export an immutable checkpoint folder. On the other machine,
use **Restore handoff** and select a new destination. References, source, assets,
local review notes and agent context travel together. Restoring preserves the
checkpoint; building a change creates a child version.

For scripts and agents, `bun run arch --help` lists the same local operations.
Use an absolute `ARCH_HOME` to choose a different store. Otherwise the browser
app, installed desktop app and CLI share the platform's application-data directory.
`bun run dev:desktop` uses `~/.arch-studio/dev-store`, shared by every checkout
and worktree, and this checkout's `.arch/desktop-profile` by default. Set
`ARCH_HOME=~/.arch-studio/dev-store` (absolute) when using the CLI or `bun dev`
with that development store. Private work stays outside Git. Existing checkout-local `.arch` stores can be opened explicitly with
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
`apps/studio/public/viewer`, with a picture of each model for the edit trays. Run it again after
updating to pick up pictures and corrected model sizes. Downloaded assets are excluded from Git. Preserve
the generated `CREDITS.md` when delivering those assets. Imported assets and
customer projects retain their own rights; the code license does not license them.

Code is [MIT licensed](LICENSE). The Enstate name and branding are separate from
the code license.
