# pi runtime lifecycle

pi is a replaceable agent runtime. The default is the **bundled Pi** shipped with the app and covered by regression tests. Advanced settings may point at an **external Pi**. An external Pi must never break the bundled Pi.

## RUN-001: reliable bundled Pi

- Do not use `createRequire().resolve(package-root)`, which triggers `ERR_PACKAGE_PATH_NOT_EXPORTED`. In development, resolve the public entry with ESM `import.meta.resolve()` + `fileURLToPath()`. Production must not depend on a workspace `node_modules` that happens to exist.
- Build-time `prepare-pi-runtime` stages the locked version and full production dependencies / dynamic assets into a self-contained runtime directory and writes `runtime-manifest.json` (version, entry, build time, protocol capabilities, content checks).
- Packaged mode locates bundled Pi only from the manifest under `process.resourcesPath`. The path must exist, be a regular file, and sit inside the runtime root.
- Startup does a version / protocol / capability handshake and records `bundledVersion`, `selectedRuntime`, and `protocolVersion`. Incompatible runtimes refuse to start and offer a recovery action.
- All launch arguments use argv with `shell:false`. Child environments are constructed from an allowlist. `NODE_OPTIONS`, `ELECTRON_RUN_AS_NODE`, debug ports, and other variables that change Node / Electron start semantics are stripped or controlled.

## RUN-002: generation and lifecycle state machine

```
idle → starting → running → stopping → stopped
                     │
                     ├─→ crashed → recovering → starting
                     └─→ stopped (expected-stop)
```

- Every runtime start creates a non-reusable `runtimeId` / generation. Agent events, UI requests, responses, stderr, and exit all carry `runtimeId + sessionId + sequence`.
- Main forwards only the current generation. The renderer also drops old generations and backward sequences.
- `dispose` must cancel the batch timer, drain queues, remove listeners, reject pending work, and distinguish `expected-stop` from `crash`.
- If any RPC fails during init, stop the child immediately, delete the map entry, clean listeners, and return a structured error plus the latest redacted stderr.
- Illegal transitions throw in development and have unit tests.

## RUN-003: SDK request reliability

- Every request has an auto-generated, non-colliding ID, a default timeout, an overridable timeout, and an `AbortSignal`. Timeout / abort must delete the pending map entry.
- Listen for child `error/exit/close`, stdin `error`, and write callbacks; handle backpressure / `drain`.
- The JSONL reader has per-line and cumulative buffer caps. Malformed lines, orphan responses, duplicate responses, and unknown events go into bounded diagnostics; critical protocol errors are not swallowed.
- After spawn `ENOENT`, the object must enter crashed/stopped, not `running=true`. If the same object may restart, an old child callback must not clear the new child.
- Stop order: refuse new commands → graceful abort / close stdin → wait → terminate → kill the process tree / Windows Job Object. Each layer has a timeout and tests.

## SES-001: unified session resolution

- Prefer pi’s public `SessionManager.list(cwd, sessionDir)` or the same resolver. Do not keep a home-grown POSIX cwd encoding copy.
- Correctly honor `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, pi settings `sessionDir`, and `path.resolve(cwd)`.
- Resolve in a worker / utility process or async I/O. Do not block Electron main with a synchronous full read.
- One corrupt / oversized JSONL must not take down other sessions. Record a redacted error and allow a diagnostic export.

## Exit checks

- A packaged Windows install with no global `pi` still starts bundled Pi.
- Session lists are correct for macOS `/Users/...`, Linux `/home/...`, and Windows `C:\...`.
- spawn ENOENT, crash-after-start, RPC timeout, malformed JSON, huge output with no newline, stdin EPIPE, and forced kill all recover.
- Fast workspace/session switches: old exit/update/UI request events must not affect the new generation (this depends on generation + sequence in the [envelope](/en/architecture/event-flow)).

Chinese companion: [pi 运行时生命周期](/runtime/).
