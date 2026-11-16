use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TaskId(pub String);

impl TaskId {
    pub fn new() -> Self {
        Self(Uuid::new_v4().to_string())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskStatus {
    Queued,
    Planning,
    Running,
    WaitingForApproval,
    NeedsAttention,
    Complete,
    Warning,
    Failed,
    Cancelled,
    Disconnected,
    Unavailable,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TaskPlan {
    pub steps: Vec<TaskPlanStep>,
    pub current_step: Option<usize>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TaskPlanStep {
    pub id: String,
    pub title: String,
    pub status: TaskStepStatus,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskStepStatus {
    Pending,
    Active,
    Complete,
    Warning,
    Failed,
    Blocked,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Task {
    pub id: TaskId,
    pub title: String,
    pub user_goal: Option<String>,
    pub repository_id: super::repository::RepositoryId,
    pub branch: Option<String>,
    pub working_directory: Option<String>,
    pub status: TaskStatus,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub messages: Vec<super::events::ChatMessage>,
    pub plan: Option<TaskPlan>,
    pub tool_events: Vec<super::events::ToolEvent>,
    pub artifacts: Vec<super::events::Artifact>,
    pub approvals: Vec<super::events::ApprovalRequest>,
    pub summary: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TaskAttentionItem {
    pub id: String,
    pub task_id: TaskId,
    pub severity: AttentionSeverity,
    pub title: String,
    pub description: String,
    pub source: AttentionSource,
    pub created_at: DateTime<Utc>,
    pub resolved: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AttentionSeverity {
    Info,
    Warning,
    Error,
    Critical,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AttentionSource {
    Fennec,
    Jev,
    OpenBot,
    Git,
    FineTune,
    Ide,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TaskSummary {
    pub task_id: TaskId,
    pub title: String,
    pub status: TaskStatus,
    pub duration_seconds: Option<f64>,
    pub files_changed: usize,
    pub tools_executed: usize,
    pub summary: String,
}
