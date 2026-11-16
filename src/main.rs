use axum::{
    extract::{Path, State, WebSocketUpgrade},
    http::StatusCode,
    response::{Html, IntoResponse, Json},
    response::sse::{Sse, Event},
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::convert::Infallible;
use tokio::sync::RwLock;
use tokio_stream::Stream;
use tower_http::cors::{CorsLayer, Any};
use tower_http::trace::TraceLayer;
use tower_http::services::ServeDir;
use uuid::Uuid;
use chrono::{DateTime, Utc};

mod task;
mod agent;
mod repository;
mod events;
mod api;
mod app;

use task::{Task, TaskStatus, TaskId};
use agent::{Agent, AgentIdentity, AgentStatus};
use repository::{Repository, RepositoryId};
use events::{EventEnvelope, EventType};

#[derive(Clone)]
struct AppState {
    tasks: Arc<RwLock<Vec<Task>>>,
    agents: Arc<RwLock<Vec<Agent>>>,
    repositories: Arc<RwLock<Vec<Repository>>>,
    active_task: Arc<RwLock<Option<TaskId>>>,
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
            active_task: Arc::new(RwLock::new(None)),
            events: Arc::new(RwLock::new(Vec::new())),
            event_tx,
        }
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let state = AppState::new();

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/health", get(health_check))
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
        .route("/api/events", get(events_sse))
        .route("/api/events/ws", get(events_ws))
        .fallback_service(ServeDir::new("web").fallback(get(serve_index)))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr = "127.0.0.1:8787";
    tracing::info!("Fennec coding agent backend listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn serve_index() -> Html<&'static str> {
    Html(include_str!("../web/index.html"))
}

async fn health_check() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        timestamp: Utc::now(),
    })
}

#[derive(Serialize)]
struct HealthResponse {
    status: String,
    version: String,
    timestamp: DateTime<Utc>,
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
                content: events::MessageContent::Text(req.content),
                attachments: Vec::new(),
                status: events::MessageStatus::Sent,
                created_at: Utc::now(),
                updated_at: None,
            };

            task.messages.push(message.clone());
            task.updated_at = Utc::now();

            let event = EventEnvelope::new(AgentIdentity::Fennec, EventType::MessageCreated)
                .with_task(task_id.clone())
                .with_payload(serde_json::json!({ "message_id": message.id }));

            let _ = state.event_tx.send(event);

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
    use futures::{SinkExt, StreamExt};

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
