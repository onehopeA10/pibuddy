# Threat model and permissions

> This page uses STRIDE to describe **trust boundaries** and mitigations. Core assumption: **the renderer may already be compromised.**

## Trust boundary

<div class="pb-trust">
  <div class="pb-trust__col">
    <div class="pb-trust__label">low trust</div>
    <div class="pb-trust__box">model output / tool artifacts / external files</div>
  </div>
  <div class="pb-trust__arrow">IPC →</div>
  <div class="pb-trust__col">
    <div class="pb-trust__label">half trust</div>
    <div class="pb-trust__box">renderer (Chromium)<br />markdown render / workspace content</div>
  </div>
  <div class="pb-trust__arrow">IPC →</div>
  <div class="pb-trust__col">
    <div class="pb-trust__label">full power</div>
    <div class="pb-trust__box">main (full Node)<br />filesystem / network / child processes</div>
  </div>
</div>

Model output is rendered as markdown and tool artifacts are spliced into the DOM. An XSS that reaches every renderer IPC method is a disaster. **Every security decision must therefore be made in main. Renderer-side checks are UX only.**

## SEC-001: safe window and navigation

- `contextIsolation:true`, `nodeIntegration:false`, `sandbox:true`, and evaluate `app.enableSandbox()`.
- Default CSP is at least `default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`. Images default to `self data: blob:`.
- `will-navigate` rejects non-app origins. `setWindowOpenHandler` defaults to deny. External links allow only normalized `https/http/mailto`.
- Permission requests (microphone and similar) go through `session.setPermissionRequestHandler` and are allowed only for the main window, a visible user action, and the required permission.

## SEC-002: narrow IPC and schema

- Delete a generic renderer `pi.command({type,...})`. Expose product actions such as `prompt/steer/followUp/abort/newSession/switchSession/setModel/...`.
- Every handler checks `event.senderFrame === event.sender.mainFrame`, a trusted origin / webContents, the payload schema, string / array / binary size, and a rate limit.
- Preload does not expose arbitrary channel names, absolute paths, URLs, environment variables, or raw Electron APIs.
- Event subscriptions return unsubscribe. Destroying a window cleans listeners so they cannot leak or double-subscribe.

## SEC-003: workspace capability

- After the user picks a directory, main registers the canonical realpath. The renderer holds only an opaque `workspaceId` and a relative path.
- Every file operation re-checks root containment, symlink / traversal, type, and size. **Do not rely on string `startsWith()` alone.**
- The pi tool layer and the desktop file API share one `PermissionEngine`: at least deny, allow once, allow session, allow workspace, plus audit and revoke.
- Product copy must call this layer “tool approval / policy”. It must not claim an OS sandbox until process isolation is implemented and verified.

## SEC-004: secrets, STT, and network

- STT / API keys live in OS secure storage or a main-process vault (`secret-store.ts` / safeStorage, fail closed). The renderer sees “configured / last four”, never plaintext.
- Provider / STT requests are issued by main from a saved endpoint ID. The renderer does not submit an arbitrary base URL and key together.
- Custom endpoints are normalized before save, require HTTPS, and apply DNS / IP blocks for private, loopback, link-local, and metadata addresses.
- SSRF tests cover at least `localhost`, `127/8`, `0.0.0.0`, integer / octal / hex IPs, IPv6 `::1`, IPv4-mapped IPv6, RFC1918, CGNAT, link-local, cloud metadata, and DNS rebinding. **Every redirect is re-resolved and re-checked.**

## Closed historical gaps

| ID | Gap | Status |
| --- | --- | --- |
| G-5 | Renderer supplied STT `baseUrl` / `apiKey` (SSRF + credentials over IPC) | **Closed**: IPC narrowed to `{endpointId, audio, mimeType}`; address / model / key stay in main |
| G-6 | `settings.json` stored keys in plaintext and was not written atomically | **Closed**: keys in `secret-store.ts` (safeStorage, fail closed); config uses `fs-atomic.ts` + `.bak` |

## Current focus

- Child processes take argument arrays. Internal commands default to `shell:false`. Only a user-opened real terminal may use shell syntax.
- Reject unknown fields, oversized strings, illegal enums, out-of-root paths, and non-main-frame calls.
- Define the threat model, permission boundary, and failure semantics before exposing any high-privilege UI.

Chinese companion: [威胁模型与权限](/security/).
