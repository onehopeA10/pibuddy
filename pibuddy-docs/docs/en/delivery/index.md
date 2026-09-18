# Updates and release

Goal: a **closed loop** from version, build, signing, publish, detect, download, install, restart, to post-upgrade health. “Open GitHub Releases” is not automatic update.

## UPD-001: update service boundary

- `UpdateService` is main-only. The renderer never touches feed URLs, tokens, file paths, or the raw updater. It uses a narrow API for state, check / download / install, and allowed preferences.
- Version truth comes from `app.getVersion()` / packaged metadata, not the renderer or a handwritten constant. Semver is strict; downgrade is refused by default.
- Dev / test returns explicit `unsupported-in-dev` or injects a fake provider and never hits the production feed.
- Private GitHub tokens / API keys must not be baked into the client. Private releases use a controlled download grant or a public keyless artifact source.

## UPD-002: state machine

Shared, serializable states at minimum:

```
unsupported · idle · checking · available · not-available ·
downloading · downloaded · waiting-for-agent · installing · error
```

State fields include at least current version, candidate version, channel, check source, last checked, release notes, download bytes / percent / speed, error code, retryable, and dismissed version. Events carry a monotonic sequence. After a renderer reload, take a snapshot first, then subscribe.

Init rules live in `UpdateService` and have unit tests: `autoDownload = false`, `autoInstallOnAppQuit = false`, `allowPrerelease = channel === 'beta'`, and `allowDowngrade = false` is set again after a channel change. Product `stable` maps to feed `latest`; product `beta` maps to `beta`.

## UPD-003: detection policy

- First check about 30 seconds after the packaged app’s main window is interactive; then about every 4 hours with 10%–20% jitter. The timer is `unref()` so it does not block quit.
- Only one check / download / install at a time. A repeat call returns the current operation instead of starting a race.
- Default `autoDownload:false`: show version, publish time, sanitized release notes, and expected size; download only after the user agrees.
- Never force a restart while the user has unsaved drafts, a recording, a running agent, or a pending permission.
- The same candidate is prompted once per process. “Later” stays quiet for 24 hours by default; Settings always remains visible.

## UPD-005: artifacts for three platforms

| Platform | First auto-update target | Key requirement |
| --- | --- | --- |
| Windows | per-user NSIS + `latest.yml` + blockmap | Sign app exe, helper, and installer together; upgrades must not change appId / user-data directory |
| macOS | DMG (distribution) + ZIP + `latest-mac.yml` | Developer ID, Hardened Runtime, entitlements, notarization, stapling; microphone usage string |
| Linux | AppImage + `latest-linux.yml` | If DEB/RPM cannot self-update reliably, the UI must degrade to “download a new package”, not fake an install |

Metadata, artifacts, and blockmap / checksums must become visible atomically: **upload artifacts first, publish the manifest last**, so a client never reads a half-published release.

## UPD-006: signing, integrity, rollback

- A production release **fails closed** if signing / notarization conditions are missing. It must not silently emit an “official unsigned” package.
- Certificates, Apple credentials, and publish tokens live only in CI secrets — never in the repo, logs, or artifacts.
- The client relies on platform signatures and updater integrity. Manifest / download errors and signature / hash mismatches abort install and show a redacted error.
- v1 does not pretend to have automatic binary rollback. At minimum: a post-update health marker, a safe-mode / diagnostics entry, staged rollout, and a fast feed withdraw.

## OBS-101: diagnostics and health

- Write a `pending-update` marker before handoff. After a healthy launch, write `last-known-good` and clear the marker.
- The first launch after an update runs a light health check: database migration, renderer ready, bundled Pi handshake. Success marks healthy; failure enters safe mode and keeps diagnostics.
- One-click support bundle; the user can preview what will be exported. Prompt, keys, Authorization, full home paths, and environment variables are redacted by default.

## UPD-007: app updates vs pi updates

- Bundled Pi follows the app version by default, signed and regression-tested with the app release. The user machine must not `npm update` it directly.
- External Pi only detects the current path, version, compatibility range, and available upgrade. It must not mutate global npm. Offer a switch back to bundled.

> Real publish values (GitHub owner/repo, signing identity, Apple Team, download domain) must be configured by the product owner in `docs/product/RELEASE_SETUP.md`. A coding agent must not invent them. If they are missing, the release job fails closed and acceptance is `not-tested/blocked-by-credential`.

Chinese companion: [更新与发布](/delivery/).
