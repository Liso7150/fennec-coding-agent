use axum::{
    body::Bytes,
    extract::{Path, Query, Request, State, WebSocketUpgrade},
    extract::DefaultBodyLimit,
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware,
    response::{Html, IntoResponse, Json, Response},
    response::sse::{Sse, Event},
    routing::{any, get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::convert::Infallible;
use tokio::sync::RwLock;
use tokio_stream::Stream;
use tower_http::trace::TraceLayer;
use tower_http::services::ServeDir;
use uuid::Uuid;
use chrono::{DateTime, Utc};

mod task;
mod agent;
mod repository;
pub mod events;
mod updater;
mod github;
mod obsidian;
mod ag_ui;
mod work;

use task::{Task, TaskStatus, TaskId};
use agent::{Agent, AgentIdentity, AgentStatus};
use repository::{Repository, RepositoryId};
use events::{EventEnvelope, EventType};

#[derive(Clone)]
pub(crate) struct AppState {
    tasks: Arc<RwLock<Vec<Task>>>,
    agents: Arc<RwLock<Vec<Agent>>>,
    repositories: Arc<RwLock<Vec<Repository>>>,
    events: Arc<RwLock<Vec<EventEnvelope>>>,
    event_tx: tokio::sync::broadcast::Sender<EventEnvelope>,
}

impl AppState {
    fn new() -> Self {
        let (event_tx, _) = tokio::sync::broadcast::channel(1000);
        Self {
            tasks: Arc::new(RwLock::new(Vec::new())),
            agents: Arc::new(RwLock::new(Vec::new())),
            repositories: Arc::new(RwLock::new(Vec::new())),
            events: Arc::new(RwLock::new(Vec::new())),
            event_tx,
        }
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    // Parse CLI arguments
    let args: Vec<String> = std::env::args().collect();
    let experimental = args.iter().any(|a| a == "--experimental");

    // Handle --experimental flag: update from source/main branch
    if experimental {
        eprintln!("[updater] Experimental mode: checking for dev updates...");
        match updater::check_experimental().await {
            Ok(Some(release)) => {
                eprintln!("[updater] Dev version available: {}", release.version);
                // In experimental mode, we'd pull from source
                // For now, just report availability
                eprintln!("[updater] Run `git pull` in the source directory to update");
            }
            Ok(None) => {
                eprintln!("[updater] Already on latest dev version");
            }
            Err(e) => {
                eprintln!("[updater] Experimental check failed: {}", e);
            }
        }
        return;
    }

    // Pre-start auto-update: check for new version before starting the server
    let current_version = env!("CARGO_PKG_VERSION");
    if let Some(new_version) = updater::pre_start_update(current_version).await {
        eprintln!("[updater] Updated to {}. Please restart.", new_version);
        return;
    }

    let state = AppState::new();

    let app = Router::new()
        .route("/health", get(health_check))
        .route("/api/health", get(health_check))
        .route("/api/capabilities", get(capabilities))
        .route("/api/models", get(models))
        .route("/api/tasks", get(list_tasks).post(create_task))
        .route("/api/tasks/:id", get(get_task).delete(delete_task))
        .route("/api/tasks/:id/start", post(start_task))
        .route("/api/tasks/:id/stop", post(stop_task))
        .route("/api/tasks/:id/messages", post(send_message))
        .route("/api/agents", get(list_agents))
        .route("/api/agents/:id/delegate", post(delegate_to_agent))
        .route("/api/repositories", get(list_repositories).post(register_repository))
        .route("/api/repositories/:id", get(get_repository))
        .route("/api/repositories/:id/status", get(repository_status))
        .route("/api/github/account", get(github_account))
        .route("/api/github/repositories", get(github_repositories).post(github_create_repository))
        .route("/api/github/detect", get(github_detect))
        .route("/api/obsidian/status", get(obsidian_status))
        .route("/api/obsidian/notes", post(obsidian_write_note))
        .route("/api/outlets", get(outlets_status))
        // Axum's default body limit is 2 MiB, well under a 16 MiB clip, so this
        // route raises it — with a MiB of headroom so an over-long body reaches
        // the handler and gets the 413 sentence instead of a bare refusal.
        .route("/api/stt", post(stt).layer(DefaultBodyLimit::max(fennec_client::MAX_AUDIO_BYTES + (1 << 20))))
        .route("/api/work/files", get(work::files))
        .route("/api/work/file", get(work::file))
        .route("/api/browse", post(work::browse))
        .route("/browse/doc", get(work::browse_doc))
        .route("/browse/raw", any(work::browse_raw))
        .route("/api/events", get(events_sse))
        .route("/api/events/ws", get(events_ws))
        .route("/api/copilotkit/agent/:agentId/run", post(ag_ui::copilotkit_run))
        .fallback_service(ServeDir::new(web_dir()).fallback(get(serve_index)))
        .layer(middleware::from_fn(revalidate_assets))
        .layer(middleware::from_fn(require_client_header))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = if let Ok(bind_addr) = std::env::var("FENNEC_AGENT_ADDR") {
        tokio::net::TcpListener::bind(&bind_addr).await.unwrap_or_else(|error| {
            panic!("failed to bind FENNEC_AGENT_ADDR={bind_addr}: {error}")
        })
    } else {
        tokio::net::TcpListener::bind("127.0.0.1:8788").await.unwrap()
    };
    let addr = listener.local_addr().unwrap();
    tracing::info!("Fennec coding agent backend listening on {}", addr);

    // The coding-agent's UI is the web PWA: open it in the user's default
    // browser. (fennec-desktop instead shows the native gpui application.)
    open_default_browser(&format!("http://{}", addr));
    if !web_dir().join("app.js").is_file() {
        // Loud, because the page still renders and only silently stops working.
        tracing::error!("no PWA app.js found; serving the embedded index without script");
    }
    axum::serve(listener, app).await.unwrap();
}

/// The outlet gates the Python core owns, served by the canonical backend so
/// both UI surfaces read one implementation without a Python server running.
async fn outlets_status() -> impl IntoResponse {
    match tokio::task::spawn_blocking(|| fennec_client::suite::discover().outlets_status()).await {
        Ok(Some(value)) => Json(value).into_response(),
        _ => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"ok": false, "error": "outlet probes unavailable: no Python core checkout on this machine"})),
        )
            .into_response(),
    }
}

/// Dictation: the raw clip a shell recorded, handed to the faster-whisper
/// sidecar, which `fennec_client::Speech` starts when nothing holds the port.
///
/// The route exists because starting the sidecar is the only way dictation can
/// work on a machine where the Python core is not running, and the shells
/// deliberately do not each own that process. Refusals use the same vocabulary
/// as `fennec-core/server.py` (`400` empty, `413` over 16 MiB, `503` the sidecar
/// could not be reached) and the same body shape the PWA reads (`detail` or
/// `error`), so neither surface has to know which server answered.
async fn stt(headers: HeaderMap, body: Bytes) -> Response {
    if body.is_empty() {
        return stt_refusal(StatusCode::BAD_REQUEST, "send raw audio bytes");
    }
    if body.len() > fennec_client::MAX_AUDIO_BYTES {
        return stt_refusal(StatusCode::PAYLOAD_TOO_LARGE, "audio must be at most 16 MiB");
    }
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("audio/webm")
        .to_string();
    let clip = body.to_vec();
    let reply = tokio::task::spawn_blocking(move || {
        let speech = fennec_client::Speech::new();
        speech.ensure()?;
        speech.transcribe(&clip, &content_type)
    })
    .await;
    match reply {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(error)) => stt_refusal(StatusCode::SERVICE_UNAVAILABLE, &error),
        Err(_) => stt_refusal(StatusCode::SERVICE_UNAVAILABLE, "the transcription task was cancelled"),
    }
}

fn stt_refusal(status: StatusCode, error: &str) -> Response {
    (status, Json(serde_json::json!({"ok": false, "error": error}))).into_response()
}

/// Open a URL in the OS default browser without flashing a console window.
fn open_default_browser(url: &str) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", url])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let _ = std::process::Command::new("xdg-open").arg(url).spawn();
}

/// Directory holding the PWA assets (`index.html`, `app.js`, `styles.css`).
///
/// `ServeDir` resolves a relative path against the process CWD, and this binary
/// is started from wherever the caller happens to be (`make run`, an IDE
/// working directory, a service launcher). The embedded `index.html` fallback
/// still renders — the shell looks fine, the inspector fills in — but `/app.js`
/// falls through to it and answers as `text/html`, so no listener is ever
/// attached: Enter, Send and the composer controls do nothing at all. Resolving
/// from the executable instead keeps the served UI working in a checkout, where
/// the binary lives two levels below `web/` (`target/debug/`), and next to the
/// assets when it is installed.
fn web_dir() -> std::path::PathBuf {
    let exe = std::env::current_exe().ok();
    let roots: Vec<std::path::PathBuf> = exe
        .as_deref()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .into_iter()
        .flat_map(|dir| {
            let up_two = dir.ancestors().nth(2).map(|p| p.join("web"));
            vec![dir.join("web"), dir.join("assets").join("web")]
                .into_iter()
                .chain(up_two)
        })
        .collect();
    roots
        .iter()
        .find(|candidate| candidate.join("app.js").is_file())
        .cloned()
        .unwrap_or_else(|| std::path::PathBuf::from("web"))
}

async fn serve_index() -> Html<&'static str> {
    Html(include_str!("../web/index.html"))
}

/// `web/` assets carry a reused `?v=` query string, and without a freshness
/// directive browsers heuristically cache them indefinitely — an old build's
/// stylesheet then silently replaces the current UI. `no-cache` forces
/// revalidation on every load; ServeDir answers If-Modified-Since, so an
/// unchanged file costs a 304 rather than a re-download. `/browse/` is left
/// alone: those routes answer with someone else's page and set their own
/// directive, which this one would overwrite.
async fn revalidate_assets(req: Request, next: middleware::Next) -> Response {
    let path = req.uri().path().to_owned();
    let mut res = next.run(req).await;
    if !path.starts_with("/api/") && !path.starts_with("/browse/") && path != "/health" {
        res.headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    }
    res
}

async fn require_client_header(req: Request, next: middleware::Next) -> Response {
    if req.uri().path().starts_with("/api/")
        && req.headers().get("X-Fennec-Client") != Some(&HeaderValue::from_static("1"))
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    next.run(req).await
}

async fn health_check() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_string(),
        backend: "rust-axum",
        version: env!("CARGO_PKG_VERSION").to_string(),
        timestamp: Utc::now(),
    })
}

#[derive(Serialize)]
struct HealthResponse {
    status: String,
    backend: &'static str,
    version: String,
    timestamp: DateTime<Utc>,
}

#[derive(Serialize)]
struct CapabilitiesResponse {
    backend: &'static str,
    implementation: &'static str,
    protocol_version: u32,
    version: &'static str,
    features: &'static [&'static str],
}

async fn capabilities() -> Json<CapabilitiesResponse> {
    Json(CapabilitiesResponse {
        backend: "fennec-coding-agent",
        implementation: "rust-axum",
        protocol_version: 1,
        version: env!("CARGO_PKG_VERSION"),
        features: &[
            "chat-only",
            "tasks",
            "agents",
            "repositories",
            "events-sse",
            "events-websocket",
            "copilotkit-ag-ui",
            "native-nod-stdio",
            "native-antigravity",
            "obsidian-local-vault-write",
            "speech-transcription",
            "static-web-assets",
        ],
    })
}

#[derive(Serialize)]
struct ServedModel {
    id: String,
    name: String,
    max_model_len: u64,
}

#[derive(Serialize)]
struct ModelsResponse {
    models: Vec<ServedModel>,
}

/// The checkpoint the engine actually holds. Fennec serves one model and answers
/// every request as it, so a client that kept its own stored choice would name a
/// model nothing is answering for. An unreachable engine yields an empty list,
/// which leaves the client on its default instead of showing an unproven model.
async fn models() -> Json<ModelsResponse> {
    let served = tokio::task::spawn_blocking(|| fennec_client::Engine::new().model_id())
        .await
        .ok()
        .flatten();
    Json(ModelsResponse {
        models: served
            .map(|(id, max_model_len)| ServedModel { name: id.clone(), id, max_model_len })
            .into_iter()
            .collect(),
    })
}

async fn list_tasks(State(state): State<AppState>) -> Json<Vec<Task>> {
    let tasks = state.tasks.read().await;
    Json(tasks.clone())
}

async fn create_task(
    State(state): State<AppState>,
    Json(req): Json<CreateTaskRequest>,
) -> impl IntoResponse {
    let task_id = TaskId(Uuid::new_v4().to_string());
    let task = Task {
        id: task_id.clone(),
        title: req.title,
        user_goal: req.user_goal,
        repository_id: req.repository_id,
        branch: req.branch,
        working_directory: req.working_directory,
        status: TaskStatus::Queued,
        created_at: Utc::now(),
        updated_at: Utc::now(),
        messages: Vec::new(),
        plan: None,
        tool_events: Vec::new(),
        artifacts: Vec::new(),
        approvals: Vec::new(),
        summary: None,
    };

    let event = EventEnvelope::new(AgentIdentity::Fennec, EventType::TaskCreated)
        .with_task(task_id.clone())
        .with_payload(serde_json::json!({ "title": task.title }));

    let _ = state.event_tx.send(event.clone());

    let mut tasks = state.tasks.write().await;
    tasks.push(task.clone());

    let mut events = state.events.write().await;
    events.push(event);

    (StatusCode::CREATED, Json(task))
}

async fn get_task(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let tasks = state.tasks.read().await;
    let task_id = TaskId(id);
    match tasks.iter().find(|t| t.id == task_id) {
        Some(task) => Ok(Json(task.clone())),
        None => Err(StatusCode::NOT_FOUND),
    }
}

async fn delete_task(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> StatusCode {
    let mut tasks = state.tasks.write().await;
    let task_id = TaskId(id);
    let len_before = tasks.len();
    tasks.retain(|t| t.id != task_id);
    if tasks.len() < len_before {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    }
}

async fn start_task(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let mut tasks = state.tasks.write().await;
    let task_id = TaskId(id);
    match tasks.iter_mut().find(|t| t.id == task_id) {
        Some(task) => {
            task.status = TaskStatus::Running;
            task.updated_at = Utc::now();

            let event = EventEnvelope::new(AgentIdentity::Fennec, EventType::TaskStatusChanged)
                .with_task(task_id.clone())
                .with_progress(0.0, "running".to_string());

            let _ = state.event_tx.send(event);

            Ok(Json(task.clone()))
        }
        None => Err(StatusCode::NOT_FOUND),
    }
}

async fn stop_task(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let mut tasks = state.tasks.write().await;
    let task_id = TaskId(id);
    match tasks.iter_mut().find(|t| t.id == task_id) {
        Some(task) => {
            task.status = TaskStatus::Cancelled;
            task.updated_at = Utc::now();

            let event = EventEnvelope::new(AgentIdentity::Fennec, EventType::TaskStatusChanged)
                .with_task(task_id.clone())
                .with_progress(1.0, "cancelled".to_string());

            let _ = state.event_tx.send(event);

            Ok(Json(task.clone()))
        }
        None => Err(StatusCode::NOT_FOUND),
    }
}

async fn send_message(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<SendMessageRequest>,
) -> impl IntoResponse {
    let mut tasks = state.tasks.write().await;
    let task_id = TaskId(id);
    match tasks.iter_mut().find(|t| t.id == task_id) {
        Some(task) => {
            let message = events::ChatMessage {
                id: Uuid::new_v4().to_string(),
                task_id: task_id.clone(),
                role: events::MessageRole::User,
                content: events::MessageContent::Text(req.content.clone()),
                attachments: Vec::new(),
                status: events::MessageStatus::Sent,
                created_at: Utc::now(),
                updated_at: None,
            };

            task.messages.push(message.clone());
            task.updated_at = Utc::now();
            task.status = TaskStatus::Running;

            let event = EventEnvelope::new(AgentIdentity::Fennec, EventType::MessageCreated)
                .with_task(task_id.clone())
                .with_payload(serde_json::json!({ "message_id": message.id }));

            let _ = state.event_tx.send(event);

            // Spawn engine interaction in background
            let engine = fennec_client::Engine::new();
            let task_id_clone = task_id.clone();
            let event_tx = state.event_tx.clone();
            let tasks_ref = state.tasks.clone();
            let messages: Vec<serde_json::Value> = task.messages.iter()
                .filter(|m| matches!(m.role, events::MessageRole::User | events::MessageRole::Fennec))
                .map(|m| serde_json::json!({
                    "role": match m.role {
                        events::MessageRole::User => "user",
                        _ => "assistant",
                    },
                    "content": m.content.as_text()
                }))
                .collect();

            std::thread::spawn(move || {
                let (tx, rx) = std::sync::mpsc::channel();
                let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
                let msgs = serde_json::json!(messages);
                engine.chat_stream(&msgs, 512, &tx, &cancel);

                let mut full_response = String::new();
                let mut reasoning = String::new();

                for delta in rx {
                    match delta {
                        fennec_client::ChatDelta::Reasoning(r) => {
                            reasoning.push_str(&r);
                            let event = EventEnvelope::new(AgentIdentity::Fennec, EventType::MessageStreamed)
                                .with_task(task_id_clone.clone())
                                .with_payload(serde_json::json!({ "kind": "reasoning", "text": r }));
                            let _ = event_tx.send(event);
                        }
                        fennec_client::ChatDelta::Content(c) => {
                            full_response.push_str(&c);
                            let event = EventEnvelope::new(AgentIdentity::Fennec, EventType::MessageStreamed)
                                .with_task(task_id_clone.clone())
                                .with_payload(serde_json::json!({ "kind": "content", "text": c }));
                            let _ = event_tx.send(event);
                        }
                        fennec_client::ChatDelta::Done => {
                            // Store the assistant message
                            let assistant_msg = events::ChatMessage {
                                id: Uuid::new_v4().to_string(),
                                task_id: task_id_clone.clone(),
                                role: events::MessageRole::Fennec,
                                content: events::MessageContent::Text(full_response.clone()),
                                attachments: Vec::new(),
                                status: events::MessageStatus::Delivered,
                                created_at: Utc::now(),
                                updated_at: None,
                            };
                            if let Ok(mut tasks) = tasks_ref.try_write() {
                                if let Some(task) = tasks.iter_mut().find(|t| t.id == task_id_clone) {
                                    task.messages.push(assistant_msg);
                                    task.status = TaskStatus::Complete;
                                    task.updated_at = Utc::now();
                                }
                            }
                            let event = EventEnvelope::new(AgentIdentity::Fennec, EventType::TaskStatusChanged)
                                .with_task(task_id_clone.clone())
                                .with_progress(1.0, "complete".to_string());
                            let _ = event_tx.send(event);
                        }
                        fennec_client::ChatDelta::Failed(e) => {
                            let event = EventEnvelope::new(AgentIdentity::Fennec, EventType::BackendDisconnected)
                                .with_task(task_id_clone.clone())
                                .with_error(format!("Engine stream failed: {e}"));
                            let _ = event_tx.send(event);
                            if let Ok(mut tasks) = tasks_ref.try_write() {
                                if let Some(task) = tasks.iter_mut().find(|t| t.id == task_id_clone) {
                                    task.status = TaskStatus::Failed;
                                    task.updated_at = Utc::now();
                                }
                            }
                        }
                    }
                }
            });

            Ok(Json(message))
        }
        None => Err(StatusCode::NOT_FOUND),
    }
}

async fn list_agents(State(state): State<AppState>) -> Json<Vec<Agent>> {
    let agents = state.agents.read().await;
    Json(agents.clone())
}

async fn delegate_to_agent(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<DelegateRequest>,
) -> impl IntoResponse {
    let agents = state.agents.read().await;
    let agent = match agents.iter().find(|a| a.identity == req.target_agent) {
        Some(agent) => agent,
        None => return Err(StatusCode::NOT_FOUND),
    };

    if agent.status != AgentStatus::Available {
        return Err(StatusCode::CONFLICT);
    }

    let event = EventEnvelope::new(req.target_agent.clone(), EventType::AgentDelegated)
        .with_task(TaskId(id))
        .with_payload(serde_json::json!({
            "scope": req.scope,
            "instructions": req.instructions
        }));

    let _ = state.event_tx.send(event);

    Ok(Json(serde_json::json!({
        "status": "delegated",
        "agent": req.target_agent
    })))
}

async fn list_repositories(State(state): State<AppState>) -> Json<Vec<Repository>> {
    let repos = state.repositories.read().await;
    Json(repos.clone())
}

async fn register_repository(
    State(state): State<AppState>,
    Json(req): Json<RegisterRepositoryRequest>,
) -> impl IntoResponse {
    let repo = Repository::new(req.name, req.local_path);

    let event = EventEnvelope::new(AgentIdentity::Fennec, EventType::GitStatusChanged)
        .with_payload(serde_json::json!({ "repository_id": repo.id.0 }));

    let _ = state.event_tx.send(event);

    let mut repos = state.repositories.write().await;
    repos.push(repo.clone());

    (StatusCode::CREATED, Json(repo))
}

async fn get_repository(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let repos = state.repositories.read().await;
    let repo_id = RepositoryId(id);
    match repos.iter().find(|r| r.id == repo_id) {
        Some(repo) => Ok(Json(repo.clone())),
        None => Err(StatusCode::NOT_FOUND),
    }
}

async fn repository_status(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let repos = state.repositories.read().await;
    let repo_id = RepositoryId(id);
    match repos.iter().find(|r| r.id == repo_id) {
        Some(repo) => Ok(Json(serde_json::json!({
            "status": repo.status,
            "sync_status": repo.sync_status,
            "changed_files": repo.changed_files,
            "staged_files": repo.staged_files,
            "ahead": repo.ahead_count,
            "behind": repo.behind_count,
        }))),
        None => Err(StatusCode::NOT_FOUND),
    }
}

async fn github_account() -> Json<github::GithubAccountStatus> {
    Json(github::account_status().await)
}

async fn github_repositories() -> Json<github::GithubRepositoryStatus> {
    Json(github::repository_status().await)
}

#[derive(Deserialize)]
struct DetectPath {
    path: String,
}

/// The PWA's workspace bootstrap, mirroring the desktop's git-remote detection:
/// a folder's GitHub `owner/repo` (from `fennec_client::git`), or null.
async fn github_detect(Query(request): Query<DetectPath>) -> Json<serde_json::Value> {
    let repository = tokio::task::spawn_blocking(move || {
        fennec_client::git::repo_context(&request.path).github_repo
    })
    .await
    .unwrap_or(None);
    Json(serde_json::json!({ "repository": repository }))
}

#[derive(Deserialize)]
struct CreateGithubRepositoryRequest {
    name: String,
    private: bool,
}

async fn github_create_repository(
    Json(request): Json<CreateGithubRepositoryRequest>,
) -> impl IntoResponse {
    match github::create_repository(&request.name, request.private).await {
        Ok(repository) => (StatusCode::CREATED, Json(repository)).into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": error })),
        )
            .into_response(),
    }
}

async fn obsidian_status() -> Json<obsidian::ObsidianStatus> {
    Json(obsidian::status())
}

async fn obsidian_write_note(
    Json(request): Json<obsidian::WriteNoteRequest>,
) -> impl IntoResponse {
    match tokio::task::spawn_blocking(|| obsidian::write_note(request)).await {
        Ok(Ok(note)) => (StatusCode::CREATED, Json(note)).into_response(),
        Ok(Err(error)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": error })),
        )
            .into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "ok": false, "error": "Obsidian write task failed" })),
        )
            .into_response(),
    }
}

async fn events_sse(State(state): State<AppState>) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = state.event_tx.subscribe();
    
    let stream = async_stream::stream! {
        let mut rx = rx;
        while let Ok(event) = rx.recv().await {
            if let Ok(json) = serde_json::to_string(&event) {
                yield Ok(Event::default().data(json));
            }
        }
    };
    
    Sse::new(stream)
}

async fn events_ws(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_ws_connection(socket, state))
}

async fn handle_ws_connection(
    mut socket: axum::extract::ws::WebSocket,
    state: AppState,
) {
    let mut rx = state.event_tx.subscribe();

    while let Ok(event) = rx.recv().await {
        if let Ok(json) = serde_json::to_string(&event) {
            if socket.send(axum::extract::ws::Message::Text(json)).await.is_err() {
                break;
            }
        }
    }
}

#[derive(Deserialize)]
struct CreateTaskRequest {
    title: String,
    user_goal: Option<String>,
    repository_id: RepositoryId,
    branch: Option<String>,
    working_directory: Option<String>,
}

#[derive(Deserialize)]
struct SendMessageRequest {
    content: String,
}

#[derive(Deserialize)]
struct DelegateRequest {
    target_agent: AgentIdentity,
    scope: String,
    instructions: String,
}

#[derive(Deserialize)]
struct RegisterRepositoryRequest {
    name: String,
    local_path: String,
}

#[cfg(test)]
mod tests {
    use super::{capabilities, github_detect, models, stt, DetectPath, Json};
    use axum::body::Bytes;
    use axum::extract::Query;
    use axum::http::{HeaderMap, StatusCode};

    /// The status and JSON sentence of a refusal from `/api/stt`, which is what
    /// the PWA's `body.detail || body.error` and the shell's toast read.
    async fn refuse(body: Bytes) -> (StatusCode, serde_json::Value) {
        let response = stt(HeaderMap::new(), body).await;
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    #[tokio::test]
    async fn a_silent_clip_is_refused_before_the_sidecar_is_started() {
        let (status, value) = refuse(Bytes::new()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(value["error"], "send raw audio bytes");
    }

    #[tokio::test]
    async fn a_clip_over_the_sidecar_cap_is_refused_with_its_limit() {
        let clip = vec![0u8; fennec_client::MAX_AUDIO_BYTES + 1];
        let (status, value) = refuse(Bytes::from(clip)).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(value["error"], "audio must be at most 16 MiB");
    }

    #[tokio::test]
    async fn capabilities_identify_the_chat_only_rust_backend_and_auxiliary_features() {
        let response = capabilities().await.0;
        assert_eq!(response.backend, "fennec-coding-agent");
        assert_eq!(response.implementation, "rust-axum");
        assert_eq!(response.protocol_version, 1);
        assert_eq!(response.version, env!("CARGO_PKG_VERSION"));
        assert!(response.features.contains(&"chat-only"));
        assert!(response.features.contains(&"events-sse"));
        assert!(response.features.contains(&"events-websocket"));
        assert!(response.features.contains(&"static-web-assets"));
        assert!(response.features.contains(&"speech-transcription"));
        for required in [
            "supervised-agent",
            "tool-execution",
            "per-call-approvals",
            "agent-polling",
        ] {
            assert!(
                !response.features.contains(&required),
                "chat-only Rust must not advertise {required}"
            );
        }
    }

    #[tokio::test]
    async fn models_reports_the_checkpoint_the_engine_holds() {
        // Shape-only: whether an engine is up on this box depends on the
        // machine, so the assertion is that nothing is invented. Either the
        // engine is unreachable and the list is empty, or every entry carries
        // the served id as its own display name.
        let Json(response) = models().await;
        for model in &response.models {
            assert!(!model.id.is_empty());
            assert_eq!(model.name, model.id);
        }
        let value = serde_json::to_value(&response).unwrap();
        assert!(value["models"].is_array());
    }

    #[tokio::test]
    async fn github_detect_reports_null_for_a_path_that_is_not_a_repository() {
        let missing = if cfg!(windows) { "Z:/definitely-not-here" } else { "/definitely-not-here" };
        let Json(body) = github_detect(Query(DetectPath { path: missing.into() })).await;
        assert_eq!(body["repository"], serde_json::Value::Null);
    }
}
