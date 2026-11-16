use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};
use uuid::Uuid;
use super::agent::AgentIdentity;
use super::task::TaskId;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EventEnvelope {
    pub event_id: String,
    pub timestamp: DateTime<Utc>,
    pub repository_id: Option<String>,
    pub workspace_id: Option<String>,
    pub task_id: Option<TaskId>,
    pub parent_task_id: Option<TaskId>,
    pub agent_identity: AgentIdentity,
    pub event_type: EventType,
    pub status: String,
    pub progress: f64,
    pub payload: Option<serde_json::Value>,
    pub error: Option<String>,
}

impl EventEnvelope {
    pub fn new(agent_identity: AgentIdentity, event_type: EventType) -> Self {
        Self {
            event_id: Uuid::new_v4().to_string(),
            timestamp: Utc::now(),
            repository_id: None,
            workspace_id: None,
            task_id: None,
            parent_task_id: None,
            agent_identity,
            event_type,
            status: "created".to_string(),
            progress: 0.0,
            payload: None,
            error: None,
        }
    }

    pub fn with_task(mut self, task_id: TaskId) -> Self {
        self.task_id = Some(task_id);
        self
    }

    pub fn with_progress(mut self, progress: f64, status: String) -> Self {
        self.progress = progress;
        self.status = status;
        self
    }

    pub fn with_payload(mut self, payload: serde_json::Value) -> Self {
        self.payload = Some(payload);
        self
    }

    pub fn with_error(mut self, error: String) -> Self {
        self.error = Some(error);
        self.status = "error".to_string();
        self
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum EventType {
    TaskCreated,
    TaskSelected,
    TaskStatusChanged,
    MessageCreated,
    MessageStreamed,
    PlanUpdated,
    ToolStarted,
    ToolProgressUpdated,
    ToolCompleted,
    ToolFailed,
    ArtifactCreated,
    ArtifactUpdated,
    AgentDelegated,
    AgentStatusChanged,
    ApprovalRequested,
    GitStatusChanged,
    GitOperationProgress,
    VoiceStateChanged,
    VisionAnalysisCompleted,
    FineTuneJobProgress,
    BackendDisconnected,
    BackendReconnected,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    pub task_id: TaskId,
    pub role: MessageRole,
    pub content: MessageContent,
    pub attachments: Vec<MessageAttachment>,
    pub status: MessageStatus,
    pub created_at: DateTime<Utc>,
    pub updated_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MessageRole {
    User,
    Fennec,
    Jev,
    OpenBot,
    Tool,
    System,
    Verification,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum MessageContent {
    Text(String),
    Code(CodeBlock),
    Reasoning(ReasoningSummary),
    Mixed(Vec<MessageContent>),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CodeBlock {
    pub language: String,
    pub code: String,
    pub filename: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReasoningSummary {
    pub summary: String,
    pub plan: Option<Vec<String>>,
    pub progress: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MessageAttachment {
    pub id: String,
    pub kind: AttachmentKind,
    pub filename: String,
    pub size_bytes: u64,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AttachmentKind {
    Image,
    File,
    Screenshot,
    Log,
    Diff,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MessageStatus {
    Pending,
    Sent,
    Delivered,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolEvent {
    pub id: String,
    pub task_id: TaskId,
    pub agent_identity: AgentIdentity,
    pub kind: ToolEventKind,
    pub status: ToolEventStatus,
    pub started_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
    pub duration_ms: Option<u64>,
    pub input: Option<serde_json::Value>,
    pub output: Option<ToolEventOutput>,
    pub error: Option<ToolEventError>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ToolEventKind {
    InspectRepository,
    ReadFile,
    SearchCode,
    CreateFile,
    EditFile,
    DeleteFile,
    ReviewDiff,
    RunCommand,
    RunTestSuite,
    BuildProject,
    LintProject,
    FormatProject,
    SearchDocumentation,
    OpenUrl,
    AnalyzeImage,
    GenerateArtifact,
    VerifyImplementation,
    GitFetch,
    GitPull,
    GitCommit,
    GitPush,
    PullRequestOperation,
    FineTuneModel,
    EvaluateFineTunedModel,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ToolEventStatus {
    Running,
    Complete,
    Warning,
    Failed,
    Cancelled,
    WaitingForApproval,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolEventOutput {
    pub summary: String,
    pub details: Option<serde_json::Value>,
    pub exit_code: Option<i32>,
    pub artifacts: Vec<Artifact>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolEventError {
    pub code: String,
    pub message: String,
    pub details: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Artifact {
    pub id: String,
    pub task_id: TaskId,
    pub kind: ArtifactKind,
    pub status: ArtifactStatus,
    pub filename: String,
    pub path: String,
    pub size_bytes: u64,
    pub created_at: DateTime<Utc>,
    pub preview: Option<ArtifactPreview>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ArtifactKind {
    Diff,
    Build,
    Test,
    Image,
    Summary,
    Report,
    Documentation,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ArtifactStatus {
    Added,
    Modified,
    Deleted,
    Generated,
    Reviewed,
    Failed,
    Pending,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ArtifactPreview {
    pub content_type: String,
    pub content: String,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ApprovalRequest {
    pub id: String,
    pub task_id: TaskId,
    pub agent_identity: AgentIdentity,
    pub action: String,
    pub risk_level: String,
    pub reason: String,
    pub affected_files: Vec<String>,
    pub command: Option<String>,
    pub choices: Vec<ApprovalChoice>,
    pub created_at: DateTime<Utc>,
    pub resolved: Option<ApprovalResolution>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ApprovalChoice {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ApprovalResolution {
    pub choice_id: String,
    pub resolved_at: DateTime<Utc>,
    pub resolved_by: String,
}
