![Fennec Coding Agent 1.0.0 — an installable, chat-first coding workspace that runs entirely against your own machine: Rust/Axum backend, plain-HTML PWA, no build step, no framework, no dependencies. 71 backend tests, 42 PWA tests, Chat and Agent modes, MIT license.](docs/hero.png)

The chat-first coding workspace: a Rust/Axum backend that owns task lifecycle, agent routing,
repository operations, per-call approvals and event streaming, plus the plain-HTML PWA it
serves on the same port.

Working version **1.0.0**; nothing at 1.0.0 is published yet — the newest published product release is `v0.9.0`.

## Architecture

```
Browser/fennec-desktop ←→ fennec-coding-agent (Rust/Axum backend on :8787, fallback :8788)
                                ↓
                           fennec-core (agent server)
                                ↓
                           Fennec engine (inference)
```

**fennec-coding-agent** (this repo):
- Rust/Axum web backend service
- Task orchestration and lifecycle management
- Agent identities carried on every event (Fennec, OpenBot, worker roles)
- Repository operations and Git workflow
- Real-time event streaming (SSE + WebSocket)
- Serves web interface on `http://127.0.0.1:8787` with `:8788` fallback

**fennec-desktop**:
- The one native window in the suite: a Rust gpui-kit application
- Primary developer workspace UI
- Connects to this backend for agent operations

**fennec-cli**:
- Command-line interface
- Console access to backend operations

Optional connectors stay outside the UI surfaces. The native Nod-compatible stdio endpoint and
Obsidian local-vault writer live in this Rust backend: Nod exposes jailed, read-only tools, while
Obsidian writes only beneath the configured vault; Obsidian handles login and Sync. Neither surface
embeds Node.js, Electron, or an Obsidian plugin runtime.

## Features

### Task Management
- Create, start, stop, and resume coding tasks
- Task planning with step-by-step progress tracking
- Message history and conversation threads
- Artifact tracking (files changed, diffs, reports)
- Approval workflow for destructive operations

### Agent Orchestration
- **Fennec** — primary coding agent, and the identity `web_task` runs under: the browser lane is Fennec's own loop, decided one step at a time by a Liquid **d1** model (the hosted `d1.2`, or a free local `d1-2B`); every event identity can also be a worker role (`Planner`, `RepositoryInspector`, `ImplementationWorker`, `VerificationWorker`, `ResearchWorker`, `VisionAnalyzer`)
- **OpenBot** — coworker-outlet identity behind `coworker_task`, driven over its own loopback AG-UI routes
- The outlet lanes are decided and driven in `fennec-core`; this repo names them on the event envelope and draws them in the timeline
- Unified timeline showing all agent activity
- Delegation with structured results and follow-up recommendations

### Repository Operations
- Git status, fetch, pull, commit, push (all with explicit confirmation)
- Branch management and sync status tracking
- Pull request awareness and creation
- Working tree change detection
- Conflict state reporting

### Real-time Events
- Server-sent events (SSE) for one-way streaming
- WebSocket for bidirectional communication
- Event envelope with task/agent/repository context
- Structured payloads for tool execution, approvals, and status changes

### Safety and Permissions
- Read-only by default
- Explicit approval required for file writes, shell commands, Git operations
- Risk-level classification (Low/Medium/High/Critical)
- Affected files listed in approval requests
- No auto-commit, auto-push, or force operations

## Build and Run

```bash
cargo build --release --offline
./target/release/fennec-agent
```

The backend starts on `127.0.0.1:8787` by default and falls back to `127.0.0.1:8788` when that port is occupied. Set `FENNEC_AGENT_ADDR` to bind the Rust/Axum server to a specific loopback address.

## API Endpoints

### Backend capabilities
- `GET /api/capabilities` — identify the Rust/Axum backend and supported protocol features

### Tasks
- `GET /api/tasks` — list all tasks
- `POST /api/tasks` — create new task
- `GET /api/tasks/:id` — get task details
- `DELETE /api/tasks/:id` — delete task
- `POST /api/tasks/:id/start` — start task execution
- `POST /api/tasks/:id/stop` — stop/cancel task
- `POST /api/tasks/:id/messages` — send message to task

### Agents
- `GET /api/agents` — list available agents
- `POST /api/agents/:id/delegate` — delegate work to agent

### Repositories
- `GET /api/repositories` — list registered repositories
- `POST /api/repositories` — register new repository
- `GET /api/repositories/:id` — get repository details
- `GET /api/repositories/:id/status` — get Git status

### Events
- `GET /api/events` — SSE event stream
- `GET /api/events/ws` — WebSocket event stream

### Web Interface
- `GET /` — serves web/index.html
- `GET /web/*` — static web assets (HTML, CSS, icons)

## Event Types

- `TaskCreated`, `TaskSelected`, `TaskStatusChanged`
- `MessageCreated`, `MessageStreamed`
- `PlanUpdated`
- `ToolStarted`, `ToolProgressUpdated`, `ToolCompleted`, `ToolFailed`
- `ArtifactCreated`, `ArtifactUpdated`
- `AgentDelegated`, `AgentStatusChanged`
- `ApprovalRequested`
- `GitStatusChanged`, `GitOperationProgress`
- `VoiceStateChanged`, `VisionAnalysisCompleted`
- `FineTuneJobProgress`
- `BackendDisconnected`, `BackendReconnected`

## Development

### Dependencies
- Rust 1.85+ (edition 2024)
- Axum 0.7 with WebSockets (web framework)
- Tokio (async runtime)
- tower-http (CORS, static files, tracing)
- fennec-client (path dependency to fennec-core) — the engine and coding-agent protocol clients
- fennec-workspace-tools (path dependency to fennec-core) — the file, shell and search tools

Context compaction is not this backend's job: the agent loop that produces long tool
transcripts runs in `fennec-core`, which calls the `fennec-economy` crate for it.

### Testing
```bash
cargo test --release --offline
```

The lane measures 71 tests in 3 cargo targets, all written in `src/` — the count is what the command printed, not what a grep of the annotations finds, since `#[tokio::test]` functions are tests too.

The front-end contract has its own lane, run with the Node test runner and needing no build:

```bash
node --test web/tests/          # 42 PWA checks: DOM contract, assets, and the parity of the Rust-rendered vocabulary
```

### Project Structure
```
src/
  main.rs          — Axum server on :8787 (:8788 fallback), routes, PWA static mount
  task.rs          — task and message domain models
  agent.rs         — agent identity, capabilities, delegation
  events.rs        — event envelope and stream types
  repository.rs    — repository and Git state models
  github.rs        — the gh-backed GitHub binding (list, create, link)
  obsidian.rs      — Markdown writes into a configured local vault
  browser.rs       — real-browser control for web_task
  work.rs          — the right panel's Files and Browser tabs
  ag_ui.rs         — AG-UI (CopilotKit) run endpoint over SSE
  nod.rs + nod_main.rs              — fennec-nod: the MCP entry point
  antigravity.rs + antigravity_main.rs — fennec-antigravity: the optional outlet
  updater.rs       — silent background update, `update --experimental` for main
web/
  index.html app.js styles.css      — the PWA: no build step, no framework
  manifest.webmanifest service-worker.js icons/
  tests/                            — the node --test contract checks
```

## Integration

### With fennec-desktop
The desktop app connects to this backend via HTTP/SSE:
```rust
let client = reqwest::Client::new();
let tasks = client.get("http://127.0.0.1:8787/api/tasks").send().await?;
```

### With fennec-core
Uses fennec-client crate for agent server communication:
```rust
use fennec_client::AgentServerClient;
let client = AgentServerClient::new("http://127.0.0.1:8787");
```

### With Fennec engine
Engine inference via fennec-core's engine SSE client:
```rust
use fennec_client::EngineSseClient;
let engine = EngineSseClient::new("http://127.0.0.1:8184");
```

## Security

- Loopback-only (127.0.0.1)
- No external network access
- No authentication required (local-only)
- No secrets read, written, or displayed
- All destructive operations require explicit approval
- Git operations never auto-execute

## Credits

Engine: [Liso7150/fennec](https://github.com/Liso7150/fennec). Base idea: [JustVugg/colibri](https://github.com/JustVugg/colibri). Agent server: [Liso7150/fennec-core](https://github.com/Liso7150/fennec-core). Part of the [Fennec suite](https://github.com/Liso7150/fennec-environment-setup).

## License

MIT — see [LICENSE](LICENSE).
