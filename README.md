# Fennec Coding Agent

Rust web backend for the Fennec coding agent orchestration layer. Provides task lifecycle management, agent routing, repository operations, and real-time event streaming via SSE/WebSocket.

## Architecture

```
Browser/fennec-desktop ←→ fennec-coding-agent (Rust/Axum backend on :8787)
                                ↓
                           fennec-core (agent server)
                                ↓
                           Fennec engine (inference)
```

**fennec-coding-agent** (this repo):
- Rust/Axum web backend service
- Task orchestration and lifecycle management
- Agent delegation (Fennec, JEV, OpenBot)
- Repository operations and Git workflow
- Real-time event streaming (SSE + WebSocket)
- Serves web interface on `http://127.0.0.1:8787`

**fennec-desktop**:
- Native Rust desktop application (egui/eframe)
- Primary developer workspace UI
- Connects to this backend for agent operations

**fennec-cli**:
- Command-line interface
- Console access to backend operations

## Features

### Task Management
- Create, start, stop, and resume coding tasks
- Task planning with step-by-step progress tracking
- Message history and conversation threads
- Artifact tracking (files changed, diffs, reports)
- Approval workflow for destructive operations

### Agent Orchestration
- **Fennec** — primary coding agent
- **JEV** — specialized delegation for repository migration and architecture analysis
- **OpenBot** — code review, test generation, documentation automation
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

The backend starts on `127.0.0.1:8787` by default.

## API Endpoints

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
- Axum 0.7 (web framework)
- Tokio (async runtime)
- tower-http (CORS, static files, tracing)
- fennec-client (path dependency to fennec-core)
- fennec-economy (path dependency for context compaction)

### Testing
```bash
cargo test --release --offline
```

### Project Structure
```
src/
  main.rs          — Axum server, routes, handlers
  api.rs           — API response types and error handling
  task.rs          — Task domain models
  agent.rs         — Agent identity, capabilities, delegation
  repository.rs    — Repository and Git state models
  events.rs        — Event envelope and stream types
web/
  index.html       — Web interface
  styles.css       — Fennec Night theme
  manifest.webmanifest — PWA configuration
  icons/           — App icons
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
