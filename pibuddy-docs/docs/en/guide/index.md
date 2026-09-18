# Start here

PiBuddy is a **desktop agent for office users**, built on pi: it keeps the workspace, host process, agent runtime, and provider configuration visible and inspectable, while everyday office work stays direct. The stack stays **Electron + Vue 3 + Pinia + Naive UI + electron-vite + electron-builder**. pi is a replaceable agent runtime; the default is the bundled Pi shipped with the app and covered by regression tests.

## Choose a path

| If you want to… | Start with |
| --- | --- |
| See what the app looks like | [Screens](/en/screens/) |
| Know what is shipped and what is out of scope | [Product scope and milestones](/en/guide/product-scope) |
| Understand how the system fits together | [Architecture](/en/architecture/) |
| Trace a protocol or storage boundary | [Event flow and envelope](/en/architecture/event-flow) |
| Understand the pi runtime lifecycle | [pi runtime lifecycle](/en/runtime/) |
| Know why a security constraint exists | [Threat model and permissions](/en/security/) |
| Understand durable state and backup | [SQLite partitions and backup](/en/data/) |
| Understand the update and release loop | [Updates and release](/en/delivery/) |
| Build a capability pack | [Extension UI and capability packs](/en/extensions/) |

The Chinese entry follows the same map: [从这里开始](/guide/).

## The mental model

```
Renderer UI  →  Preload bridge  →  Electron Main authority
     ↓                  ↓                    ↓
 session reduce    @pibuddy/contract      pi Node sidecar
                   (types + runtime schema)  + 12 SQLite databases
```

The renderer owns presentation. Preload exposes narrow, verifiable, revocable product actions under `contextIsolation`. Electron main owns desktop capabilities: window lifecycle, IPC routing, process supervision, the permission center, secret custody, the update client, and persistence. The pi sidecar owns the agent loop and provider-facing model work.

## Working with the docs

The source of truth is the engineering documents in the main repository under `doc/` and `docs/product/`. Technical identifiers — protocol fields, database names, RPC methods, requirement IDs — stay unchanged so search and cross-reference paths remain stable. Use **global search** when you know a term, protocol method, or requirement number; use the **sidebar** when you are exploring a domain.

## Before you change a boundary

1. Read the relevant spec and the matching domain page.
2. Check the linked decisions and constraints.
3. Update the test scenario when behavior is user-visible or protocol-visible.
4. Run the narrowest useful validation, then record the result in the change.

> Constraints come before implementation details. This site describes **boundaries and contracts**; implementation details belong in source comments.
