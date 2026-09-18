# Product scope and milestones

PiBuddy is not a demo and not a handful of extra UI buttons. The work is to turn the existing project into a **cross-platform desktop agent that can be installed, recovered, updated, diagnosed, and safely shipped**.

- `PRIMARY_PLATFORM`: Windows 11 x64
- `SECONDARY_PLATFORMS`: macOS arm64/x64, Ubuntu x64
- `PRODUCT_MODE`: a personal agent / AI office assistant for ordinary users; developer features live in advanced mode

The default UI is for non-developers: chat, files/artifacts, history, tasks, settings. PTY, advanced Git, worktrees, and debug logs live in “developer / advanced mode”.

## Milestone map

| Milestone | Goal | Release meaning |
| --- | --- | --- |
| M0 | Baseline, contracts, test skeleton | Not released |
| M1 | Bundled Pi, session resolver, runtime supervisor | Internal |
| M2 | Electron / IPC / permission / secret security | Internal |
| M3 | Sessions, providers, Extension / Pi resources, daily UX | Feature beta |
| M4 | Updates, signing, CI/CD, diagnostics | Distributable beta baseline |
| M5 | Workspace, Office/PDF, artifacts | Office product v1 core |
| M6 | PTY, Git/Review, checkpoint/worktree | Developer advanced mode |
| M7 | Background session pool, child-agent orchestration | Agent platform beta |
| M8 | Durable tasks, long-term memory | Personal agent OS beta |
| M9 | Remote / PWA / IM, browser, plugin platform | High-risk, separate beta |
| M10 | GA performance, accessibility, privacy, support | GA |

Do not skip M1–M2. M7 cannot precede worktrees and the permission center. M9 cannot precede unified auth, device scopes, and audit.

## Requirement prefixes

Requirements use ID prefixes so a need can be traced to implementation and tests:

| Prefix | Domain | Prefix | Domain |
| --- | --- | --- | --- |
| `RUN-*` | Pi runtime / SDK | `UPD-*` | App / Pi updates |
| `SES-*` | Sessions | `AGT-*` | Background / child agents |
| `SEC-*` | IPC / permissions / secrets / navigation | `AUT-*` | Automation |
| `EXT-*` | Extension UI / Pi resources | `MEM-*` | Memory |
| `PROV-*` | Provider / model / auth | `REM-*` | Remote and devices |
| `FS-*` | Files and attachments | `OBS-*` | Logs / diagnostics / crashes |
| `ART-*` | Office / artifact / preview | `QA-*` | Tests / CI / release |
| `PTY-*` | Terminal | `GIT-*` | Git / worktree / checkpoint |

## Definition of Done

A requirement is complete only when all of the following are true:

1. A user can enter, operate, cancel, and see success / failure / recovery from the UI.
2. The main / preload / renderer boundary is complete; IPC has a runtime schema and sender checks.
3. Critical state recovers or is explicitly cleaned after a window reload, agent crash, or app restart.
4. Errors do not leak keys, full environment variables, sensitive paths, or raw stderr; a redacted diagnostic export remains available.
5. Tests cover the happy path, cancel, timeout, abnormal exit, duplicate calls, and at least one platform difference.
6. Typecheck, unit, integration, renderer E2E, and production build pass.
7. Features that touch install / update / runtime are verified on a packaged app, not only the dev server.
8. Docs, settings copy, migrations, and required strings are in sync; a requirement can be traced to implementation and tests.

## Explicitly deferred or out of scope

- No in-house agent runtime (that is pi’s job) and no in-house provider / model gateway (pi already supports multiple providers).
- Office v1 is safe preview, artifact versions, and controlled export — not a full online Office editor.
- Git v1 is local status / diff / stage / commit / worktree, not a full PR platform.
- Without process / realm isolation, only built-in plugins are allowed; a manifest cannot claim safety by itself.
- Memory starts as explicit save, provenance, and delete — conversations are not written to long-term memory by default.
- Remote is off by default. The product UI is Chinese-first; this documentation site is bilingual. No telemetry upload.

Chinese companion: [产品范围与里程碑](/guide/product-scope).
