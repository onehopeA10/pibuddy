# Architecture

> This page describes **constraints**, not implementation details. Implementation details belong in module source comments.

## Package boundaries

| Package | Role | How it is consumed |
| --- | --- | --- |
| `@pibuddy/contract` | The single source of truth for types and **runtime schema** shared by main / preload / renderer / pi-sdk | Source form (`main` points at `src/index.ts`; no dist) |
| `@pibuddy/pi-sdk` | Client and types for the pi RPC protocol (JSONL over stdio) | Source form |
| `@pibuddy/app` | Electron app: main / preload / renderer | Bundled by electron-vite |

`noEmit: true` in `tsconfig.base.json` means workspace packages are consumed as **source**: the app includes `src/**/*.ts` from contract and pi-sdk directly. There are no project references and no intermediate artifacts.

> Adding a workspace package requires three edits at once; missing one blows up at runtime:
> 1. `externalizeDepsPlugin({ exclude: [...] })` in `packages/app/electron.vite.config.ts` — the build can pass while runtime reports an unresolvable external.
> 2. `include` in `tsconfig.node.json` / `tsconfig.web.json`.
> 3. `paths` in `tsconfig.web.json` and the renderer `alias` in `electron.vite.config.ts`.

## Dependency direction (hard rule)

```
renderer  →  preload  →  main  →  pi-sdk  →  pi child process
                 ↘         ↓        ↙
                  @pibuddy/contract
```

- **No reverse edges**: main must not import anything from renderer; pi-sdk must not know about Electron.
- **contract is only depended on**: it depends on no workspace package. `StartResult` therefore uses generic slots (`StartResult<TState, TModel, TMessage>`) instead of pi-sdk types — a contract → pi-sdk edge would drag `node:child_process` into renderer type-checking.
- **No hardcoded cross-layer paths**: the renderer always takes types through `@contract`. `scripts/check-contract-uniqueness.mjs` turns that rule into a CI assertion.

## Port interfaces

`contract/src/ports.ts` types the ports; it does not implement them. Landing by milestone:

| Port | Milestone |
| --- | --- |
| `PiRuntimeSupervisor` | M1 |
| `SessionRepository` | M1 |
| `PermissionEngine` | M2 (`ipc-guard.ts implements PermissionEngine`) |
| `SettingsStore` | M3 |
| `UpdateService` | M4/M5 |

## Single implementations (do not write a second copy)

| Capability | Only implementation | Reused by |
| --- | --- | --- |
| Structured redacted logs | `app/src/main/logger.ts` | All of main |
| Redaction rules | `app/src/main/logger-redact.ts` | logger, support-bundle, connectivity |
| Atomic write | `app/src/main/fs-atomic.ts` | workspace records, settings.json, auth.json, health marker |
| Test config | repo-root `vitest.config.ts` | Whole repo |

`scripts/check-contract-uniqueness.mjs` and `scripts/check-test-discovery.mjs` make uniqueness an executable CI assertion.

## Read next

- [Event flow and envelope](/en/architecture/event-flow): how cross-process events are framed, normalized, batched, and reduced into Vue.
- [pi runtime lifecycle](/en/runtime/): generation, the state machine, and SDK request reliability.
- [SQLite partitions and backup](/en/data/): consistency of the twelve databases and two-phase restore.

Chinese companion: [架构总览](/architecture/).
