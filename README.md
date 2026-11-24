![Fennec Coding Agent 1.0.0 — an installable, chat-first coding workspace that runs entirely against your own machine: Rust/Axum backend, plain-HTML PWA, no build step, no framework, no dependencies. 77 backend tests, 70 PWA tests, Chat and Agent modes, MIT license.](docs/hero.png)

Fennec Coding Agent is the suite's Rust/Axum chat and integration service. The canonical supervised coding PWA/API is [`fennec-core/server.py`](https://github.com/Liso7150/fennec-core) on `127.0.0.1:8787`; this service is separate and does not replace it.

## Architecture

| Service | Address | Role |
|---|---|---|
| `fennec-core/server.py` | `127.0.0.1:8787` | Canonical supervised PWA/API: agent loop, tools, approvals, polling |
| `fennec-agent` (this repository) | `127.0.0.1:8788` | Auxiliary chat, events, static assets, and integrations |
| Fennec engine | `127.0.0.1:8184` | Native Rust inference |

`GET /api/capabilities` identifies this backend as `fennec-coding-agent` / `rust-axum` and advertises `chat-only`. It does not advertise `supervised-agent`, `tool-execution`, `per-call-approvals`, or `agent-polling`, and it is never a coding fallback. The desktop sends coding work only to a capable `fennec-core` service.

The Rust service binds exactly to `127.0.0.1:8788` by default. `FENNEC_AGENT_ADDR` overrides that address; a bind failure exits rather than selecting another port. Core owns `8787` independently.

## Responsibilities

- Stream model chat and expose the engine's served model through `/api/models`.
- Serve the static PWA assets. Core serves this same `web/` directory on the canonical PWA/API origin.
- Maintain auxiliary task/message/event records and stream them over SSE and WebSocket. These records are not supervised coding sessions and carry no tool-execution or approval authority.
- Provide an AG-UI-compatible chat endpoint for CopilotKit clients.
- Expose native `fennec-nod` stdio with jailed, read-only workspace tools and local-model chat.
- Provide the opt-in Obsidian local-vault writer and local speech transcription.

The `/api/tasks`, `/api/agents`, and `/api/repositories` route families are compatibility surfaces for auxiliary chat records. They do not own the suite's coding-agent loop, workspace tool execution, or per-call approvals.

## Build and run

Requires Rust 1.85+ (edition 2024) and a sibling `fennec-core` checkout for the `fennec-client` and `fennec-workspace-tools` path dependencies.

```bash
cargo build --release --offline --bin fennec-agent
./target/release/fennec-agent
```

To select another loopback address:

```bash
FENNEC_AGENT_ADDR=127.0.0.1:8788 ./target/release/fennec-agent
```

The process opens its PWA in the default browser. For supervised coding, start `python server.py serve` in `fennec-core` and use `http://127.0.0.1:8787`.

## HTTP surface

| Route | Purpose |
|---|---|
| `GET /health`, `GET /api/health` | Rust service health |
| `GET /api/capabilities` | Backend identity and `chat-only` feature advertisement |
| `GET /api/models` | Model currently served by the engine |
| `POST /api/copilotkit/agent/:agentId/run` | AG-UI chat stream over SSE |
| `GET /api/events` | Auxiliary event stream over SSE |
| `GET /api/events/ws` | Auxiliary event stream over WebSocket |
| `GET /` | Static PWA entry point and assets |

API requests require `X-Fennec-Client: 1`. The default bind is loopback-only; do not expose an override on an untrusted network.

## External connectors

`fennec-nod` is a separate native stdio executable. It exposes Fennec status, jailed workspace listing, file reading, grep, and model chat. It does not expose writes, shell execution, browser automation, coworker delegation, or the supervised agent loop.

Obsidian support is enabled only for a configured local vault. Titles and folders remain beneath that vault, existing notes require explicit overwrite, and Obsidian owns login and Sync. Neither connector embeds Node.js, Electron, or an Obsidian plugin runtime.

## Tests

```bash
cargo test --release --offline          # 77 Rust tests
node --test web/tests/          # 70 PWA checks: DOM contract, assets, and the parity of the Rust-rendered vocabulary
```

The Rust suite covers the chat-only capability contract, routes, events, integrations, and jailed tools. The Node suite checks the PWA DOM contract, assets, and Rust-rendered vocabulary without a build step.

## Layout

```text
src/
  main.rs                 Axum service, routes, exact bind address
  ag_ui.rs                AG-UI chat streaming
  events.rs               Event envelopes and stream types
  task.rs                 Auxiliary task/message records
  agent.rs                Auxiliary agent identities
  repository.rs           Repository metadata
  github.rs               gh-backed GitHub integration
  obsidian.rs             Local-vault Markdown writes
  work.rs                 Files and Browser panels
  nod.rs, nod_main.rs     Native read-only MCP stdio endpoint
  updater.rs              Release update checks
web/
  index.html, app.js, styles.css
  manifest.webmanifest, service-worker.js, icons/
  tests/                  Node contract tests
```

Context compaction belongs to `fennec-core` and the shared `fennec-economy` crate, not this service.
