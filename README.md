# ds-cover

[Cover](https://github.com/DavidCarliez/cover) privacy protection for **DeepSeek Harness Web**. A lock at the bottom of the app shows protection status and opens the control panel.

The plugin routes native DeepSeek API-key and account requests through the real Cover engine. Cover filters sensitive content before it reaches DeepSeek and restores reversible replacements in responses, including streamed text and tool arguments.

## Quick start

**Requires:** DeepSeek Harness **0.2.1-rc.2** (tested), Node.js **22+**, and [Cover **0.3.0+**](https://github.com/DavidCarliez/cover#install). The `cover` executable must be on the harness process's PATH, or set through `COVER_BIN`.

From this repository, run:

```sh
npm ci
npm run build
dsh plugin --profile web add "link:$PWD"
```

Open the harness, click the **Cover** lock, review **Setup checks**, then select **Start**. Alternatively, run `/cover start` in a session.

**Protection starts enabled; automatic fallback starts disabled.** Until the daemon is running, native DeepSeek requests are blocked rather than sent unprotected. Install, restart, or disable the plugin only when no generation is active.

## Using Cover

- **Overview:** toggle protection, manage the daemon, and check setup and health. **Advanced management** contains model downloads and Cover updates/rollbacks.
- **Policy:** edit and validate the full YAML policy, including custom detectors and all six actions: `allow`, `placeholder`, `pseudonymize`, `mask`, `redact`, and `block`. Drafts survive tab switches; closing asks before discarding unsaved changes.
- **Inspect:** preview a request's transformations locally, without sending it to DeepSeek.
- **Activity:** view request metadata, or explicitly enable a temporary live view of sensitive content.

Saved changes remain marked **pending restart** until Cover reloads them. Starting an already-running daemon does not apply changes. The lock also warns when automatic fallback is enabled, even while Cover is healthy.

The lock describes the selected provider's **next request**, not all traffic on the machine:

| Status | Meaning |
| --- | --- |
| Protected | The native route is configured and Cover is healthy. |
| Blocked | Protection is enabled, but the protected route is unavailable. |
| Protection off | Requests bypass Cover. |
| Unprotected fallback | Cover is unavailable and explicitly enabled fallback permits direct requests. |
| Not configured | The selected provider is not supported. |
| Status unknown | The selected provider or current connection status cannot be verified. |

A failed or policy-blocked request is **never retried directly**. Updates and rollbacks change the shared Cover executable and can affect other integrations. Downloads and executable updates require an explicit action.

Session commands: `/cover status`, `on`, `off`, `start`, `stop`, `restart`, `doctor`, `test`, `monitor`, `fallback on/off`, and `models status/pull`. Prefix each with `/cover`; use the panel for detailed output.

## Configuration and privacy

Runtime files live outside the repository in `~/.local/share/ds-cover`. The policy is at `.config/cover/config.yaml` inside that directory.

On first use, ds-cover validates and imports an existing `~/.config/cover/config.yaml` policy, if present; otherwise it uses Cover's stock defaults. It assigns separate routing, key, and log settings without changing the original configuration or daemon. Later edits to the original policy are not imported automatically.

**Personal policies, allowlists, keys, and logs are not shipped or committed.** Repository test rules are synthetic. The policy editor changes only the private runtime configuration.

Protection has limits:

- Only native DeepSeek API-key and account providers are covered. Other providers, shell commands, browser traffic, MCP tools, sign-in, and telemetry are outside this boundary.
- Connection credentials still reach DeepSeek. Images and opaque attachments are not scanned; use `media.images: block` when image content must not leave.
- Previews and opt-in live captures can expose sensitive content to the authenticated browser. Use a trusted connection and avoid screen sharing. Live views clear on connection resets; abandoned views expire within 15 seconds.
- Removing or disabling the plugin restores the underlying provider routing. Stopping only the daemon leaves protection enabled and requests blocked, unless fallback is enabled.

See [Cover's security boundary](https://github.com/DavidCarliez/cover#security-boundary) for detector and protocol limits.

## Development

```sh
npm test
npm run build
npm run check:package
```

Tests use the real Cover binary and native DeepSeek adapter with temporary policies and loopback upstreams—no cloud model calls. They cover policy actions, streaming/tool restoration, authentication, fail-closed routing, policy activation, and client lifecycle. CI runs on Node.js 22 and 24.

`npm pack` builds bundles automatically. `check:package` verifies a clean-source package and loads its host and client entry points.

Rebuild after source edits. Client changes reload through the harness; host changes require profile recomposition or restart unless HMR watches this repository.

## License

Apache-2.0. Built on [DavidCarliez/cover](https://github.com/DavidCarliez/cover) and the native DeepSeek Harness plugin APIs.
