# Arch Studio desktop

macOS releases contain `Arch-Studio-<version>-arm64.dmg` for Apple Silicon and
`Arch-Studio-<version>-x64.dmg` for Intel. Drag Arch Studio into Applications.
The app and its bundled Bun/server executables are Developer ID signed. The
app is notarized and stapled before the DMG and updater ZIP are created.

Installed releases check GitHub Releases after 15 seconds and every four minutes.
The Studio sidebar and **Arch Studio → Check for Updates** expose the same flow:
check, choose **Download update**, then confirm **Restart and install**. Checks
never download or install automatically. Closing Studio does not install an
update. A failed download can be retried. A stalled installer restarts the app;
an unfinished installation is detected on the next launch. Updates
replace the application, while projects and checkpoints stay in the user's store.

The main process owns the fixed `Enstate/arch-studio` stable feed. The isolated
preload exposes only update operations and state, with main-frame/origin checks
on every request. No provider login or Enstate account is required.

## Development and local verification

`bun run dev:desktop` owns one loopback Vite process and one Electron process.
Set `ARCH_STUDIO_PORT` to choose an unused development port. Closing the desktop
window stops its server. Development and unsigned preview builds disable updates.

```sh
bun run build:studio
bun run package:desktop:preview --version 0.1.3
```

Preview output is under `artifacts/arch-studio-darwin-<arch>-preview`. It is local
test output, not a signed distribution. Linux preview output is an unpacked app.

For a signed macOS release, provide `CSC_LINK` (P12 path or base64),
`CSC_KEY_PASSWORD`, and either `APPLE_KEYCHAIN_PROFILE`, App Store Connect API
key credentials, or Apple ID/app-specific password/team credentials. An existing
`CSC_KEYCHAIN` is also supported. The keychain profile authenticates an Apple
team and can be reused across its apps. Never commit or bundle these credentials.

```sh
APPLE_KEYCHAIN_PROFILE=<existing-profile> bun run package:desktop:release --version 0.1.3
bun scripts/verify-desktop.ts
```

The packager uses an owned temporary signing keychain and removes it on exit.
It preserves the exact viewer source/manifest bytes, compiles the SSR server,
and bundles the matching host-architecture Bun runtime. Run each architecture
with its matching Bun/Electron toolchain. Installer and updater bytes must stay
unchanged after `latest-mac.yml` is generated.

Verification creates a disposable synthetic store, opens the actual packaged
app, builds a version, downloads its reference and checks shutdown. It uses the
native macOS display. Do not add `--headless`: Chromium substitutes an 800x600
1x display, which makes the visible window blurry on Retina screens. The harness
asserts the UI pixel ratio matches the display and captures device pixels.

## Publication

The tag workflow builds native arm64 and x64 apps, source archives and one merged
`latest-mac.yml`. CI needs `MACOS_CERTIFICATE_P12`, `MACOS_CERTIFICATE_PASSWORD`,
and either `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD` or
`APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER` secrets. The team is
`3T885JB4UJ`. An API key secret may contain the P8 text; it is written only to a
private temporary file and removed after notarization.

`bun scripts/desktop-update-manifest.ts release` merges downloaded architecture
manifests. `RELEASE_TAG`, full `GITHUB_SHA` and `GH_REPO` identify
`bun scripts/publish-desktop-release.ts release`. Publication verifies every
source and desktop hash, resumes a matching incomplete draft without replacing
assets, and publishes only after the remote set is complete. A published release
is immutable. The DMG is for installation; ZIP, blockmaps and `latest-mac.yml`
are also required for in-app updates.
