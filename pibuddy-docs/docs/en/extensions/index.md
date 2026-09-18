# Extension UI and capability packs

PiBuddy’s extensibility has two layers: **native pi resources** (prompts / skills / extensions / themes / agents / MCP) and **future PiBuddy UI plugins**. They use different manifests, permissions, and hosts. Do not collapse them into one layer.

## EXT-101: complete Extension UI

- Cover select / confirm / input / editor / notify / setStatus / setWidget / setTitle / set editor text, plus every UI RPC method published by the current pi version.
- Dialogs support timeout, `AbortSignal`, runtime generation, queued requests, and restore / cancel after a window reload. When upstream times out, the local modal dies immediately.
- Widgets have a stable key, placement, update / delete, and a height cap. Titles go through a product prefix and length limit.
- An extension request must never receive Electron APIs directly. UI content is plain text or a restricted renderer.
- Show pi project trust: source, project resources that will load, allow / deny / remember. **Trust is not tool permission.**

## EXT-102: pi resource center

- Enumerate packages, extensions, skills, prompts, themes, and MCP from user / project / package sources. Show path, version, source, enabled state, conflicts, and diagnostics.
- Support install, uninstall, start / stop, refresh, open directory, and version lock. Project resources require trust first.
- Install sources must be normalized and must show the permissions they will execute / access. **The renderer must not run an arbitrary package-manager command.**
- MCP supports CRUD, start / stop, connection tests, OAuth state, tool lists, and error diagnostics. Credentials stay in main.

## Capability packs: loading content

`pi-resources/resource-scanner` already recognizes every pi resource type. A capability pack ships domain content (prompts / skills / in-loop tools / UI contributions) and loads / unloads it through one materialization path.

### R4: pack load / unload (foundation)

- **Manifest extension**: a pack may declare pi resources it carries (prompts / skills / extensions). Resource files ship with the pack.
- **Load / unload**: enabling a pack materializes resources into the pi resource directory; disabling removes them. Materialization must be **idempotent and re-entrant** — a repeat enable does not write twice; an upgrade overwrites the old version.
- **Permissions**: in-loop tool actions go through the existing permission engine (five gates). No side door. Declared permission needs go in `manifest.permissions` and are shown at install.
- **Acceptance**: pure-function tests cover idempotent materialize / remove. Structural assertions prove materialization cannot bypass a permission gate.

### What a loaded vertical pack looks like

A sample vertical pack must carry all four content types so the architecture actually closes:

| Content | Meaning |
| --- | --- |
| prompts | Domain prompts (≥5) |
| skills | Domain skills (≥2) |
| In-loop tools | ≥1 pi extension tool |
| UI contributions | uiContributions mounts at least one domain panel / entry |

Design rule: **deterministic actions stay in code; explanation / attribution stay with the model**. Example: a worksheet generator produces items and answer keys in code; the model explains them. After install, the in-session agent gains the domain tools and skills. After uninstall they disappear and generic capability has zero residue (covered by drift tests).

## Boundary notes

- Native pi resources and PiBuddy UI plugins have different hosts. Third-party code must not dynamically import into the main renderer realm. Use a utility process / worker / sandboxed iframe with no file / network / shell / secret by default.
- Without process / realm isolation, only built-in / officially signed sources are allowed. A public marketplace, payments, and ratings are deferred.
- See [Threat model and permissions](/en/security/) for the tool-approval layer, and [Product scope](/en/guide/product-scope) for the related milestones.

Chinese companion: [Extension UI 与能力包](/extensions/).
