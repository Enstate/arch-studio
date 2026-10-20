# Local desktop shell

Install the locked workspace dependencies, then run `bun run dev:desktop` from
this checkout. This owns one loopback Vite process and one Electron process and
stops both on exit. Set `ARCH_STUDIO_PORT` to choose an unused development port.

To package, first run `bun run build:studio`, then `bun run package:desktop`.
The package script uses the installed Electron distribution and the currently
running Bun executable. It compiles the built SSR entry into a standalone Bun
server and includes the client files, Bun project-build runtime, and byte-exact
viewer source and manifest. No runtime dependency installation is required.
Compilation errors stop packaging. Output under `artifacts/` is local output and
must stay out of Git.

Packaging targets only the current macOS or Linux host and architecture. macOS
output is an app and ZIP with a local ad-hoc signature, without notarization or a
distribution identity. Linux output is an unpacked directory with its Electron
executable. Test the produced application on that host before sharing it.

The packaged application stores projects under its per-user application-data
folder. It starts a private server on an ephemeral loopback port, denies browser
permissions, and opens clicked HTTPS links in the system browser. Closing the
window stops its server. There are no updater or cloud-account dependencies.
