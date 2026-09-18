# Event flow and envelope

## Five hops

```
[1] pi child stdout
      │  JSONL, one event per line
      ▼
[2] pi-sdk/jsonl.ts framing
      │  StringDecoder + LF split; bad lines skipped, stream continues
      ▼
[3] pi-sdk/client.ts dispatch  ── toAgentEvent() normalize
      │  response (with id) → pending promise
      │  extension_ui_request → "ui_request"
      │  everything else → "event" (unmodeled types become { type:"unknown", raw })
      ▼
[4] app/main/ipc.ts 33ms batch
      │  collapse consecutive accumulating events (message_update / same
      │  toolCallId tool_execution_update carry the full prefix so far; keep the last)
      ▼
[5] preload → renderer store reducer
      │  stores/app.ts handleEvent() switch(e.type)
      ▼
   Vue components
```

Hop 4 used to fold on the event `type` and `toolCallId`. After enveloping, it folds on `envelope.payload.type` — which is why `payload` must be a **formal envelope field**, not an extra property hung on the side.

## Envelope `PiEnvelope<T>`

Eight fields, all required (`contract/src/envelope.ts`, `PROTOCOL_VERSION = 1`):

| Field | Role |
| --- | --- |
| `protocolVersion` | Version gate. `parseEnvelope` compares it first and rejects immediately on mismatch |
| `workspaceId` | Workspace identity (stable from M1) |
| `sessionId` | pi session ID |
| `runtimeId` | One pi child-process instance |
| `generation` | Generation. Increments on each start / restart so late events from the previous generation can be dropped |
| `sequence` | Monotonic inside the same `(sessionId, generation)` |
| `occurredAt` | Unix ms observed by main |
| `payload` | The event body |

## Unknown protocol versions fail closed

It is better to stop the whole path than to let a new-version field become `undefined` in an old renderer and be swallowed.

Version comparison is deliberately **before** structural validation. Reversing that would classify a v2 envelope as malformed first; operators would see the wrong error class. Every cross-process event is checked with a runtime schema. TypeScript types are not treated as a runtime trust boundary. Unknown fields, oversized strings, illegal enums, out-of-root paths, and non-main-frame calls are rejected.

## Why sequence is monotonic

- Main forwards only the **current generation**; the renderer also drops old generations and backward sequences.
- Fast workspace / session switches must not let an old process’s exit / update / UI request pollute the new generation.
- Generation + sequence is a direct dependency of the [pi runtime lifecycle](/en/runtime/) state machine.

Chinese companion: [事件流与信封](/architecture/event-flow).
