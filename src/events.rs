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
    OpenBot,
    Tool,
    System,
    Verification,
}

#[derive(Clone, Debug)]
pub enum MessageContent {
    Text(String),
    Code(CodeBlock),
    Reasoning(ReasoningSummary),
    Mixed(Vec<MessageContent>),
}

// Text is a plain JSON string on the wire; structured variants stay tagged.
impl Serialize for MessageContent {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            MessageContent::Text(s) => serializer.serialize_str(s),
            other => {
                use serde::ser::SerializeMap;
                let mut map = serializer.serialize_map(Some(1))?;
                match other {
                    MessageContent::Code(c) => map.serialize_entry("Code", c)?,
                    MessageContent::Reasoning(r) => map.serialize_entry("Reasoning", r)?,
                    MessageContent::Mixed(parts) => map.serialize_entry("Mixed", parts)?,
                    MessageContent::Text(_) => unreachable!(),
                }
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for MessageContent {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let v = serde_json::Value::deserialize(deserializer)?;
        match v {
            serde_json::Value::String(s) => Ok(MessageContent::Text(s)),
            serde_json::Value::Object(map) if map.len() == 1 => {
                let (key, val) = map.into_iter().next().expect("len checked");
                match key.as_str() {
                    "Text" => serde_json::from_value::<String>(val)
                        .map(MessageContent::Text)
                        .map_err(serde::de::Error::custom),
                    "Code" => serde_json::from_value::<CodeBlock>(val)
                        .map(MessageContent::Code)
                        .map_err(serde::de::Error::custom),
                    "Reasoning" => serde_json::from_value::<ReasoningSummary>(val)
                        .map(MessageContent::Reasoning)
                        .map_err(serde::de::Error::custom),
                    "Mixed" => serde_json::from_value::<Vec<MessageContent>>(val)
                        .map(MessageContent::Mixed)
                        .map_err(serde::de::Error::custom),
                    _ => Err(serde::de::Error::custom("unknown message content variant")),
                }
            }
            _ => Err(serde::de::Error::custom("invalid message content")),
        }
    }
}

impl MessageContent {
    pub fn as_text(&self) -> String {
        match self {
            MessageContent::Text(s) => s.clone(),
            MessageContent::Code(c) => c.code.clone(),
            MessageContent::Reasoning(r) => r.summary.clone(),
            MessageContent::Mixed(parts) => parts.iter().map(|p| p.as_text()).collect::<Vec<_>>().join("\n"),
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_envelope_new_sets_defaults() {
        let event = EventEnvelope::new(AgentIdentity::Fennec, EventType::TaskCreated);
        assert_eq!(event.agent_identity, AgentIdentity::Fennec);
        assert_eq!(event.event_type, EventType::TaskCreated);
        assert_eq!(event.status, "created");
        assert_eq!(event.progress, 0.0);
        assert!(event.task_id.is_none());
        assert!(event.payload.is_none());
        assert!(event.error.is_none());
        assert!(!event.event_id.is_empty());
    }

    #[test]
    fn event_envelope_builder_chain() {
        let task_id = TaskId("task-123".to_string());
        let event = EventEnvelope::new(AgentIdentity::OpenBot, EventType::MessageCreated)
            .with_task(task_id.clone())
            .with_progress(0.5, "running".to_string())
            .with_payload(serde_json::json!({"key": "value"}))
            .with_error("test error".to_string());

        assert_eq!(event.task_id, Some(task_id));
        assert_eq!(event.progress, 0.5);
        assert_eq!(event.status, "error");
        assert!(event.payload.is_some());
        assert_eq!(event.error, Some("test error".to_string()));
    }

    #[test]
    fn event_type_round_trips() {
        let types = vec![
            EventType::TaskCreated,
            EventType::TaskSelected,
            EventType::TaskStatusChanged,
            EventType::MessageCreated,
            EventType::MessageStreamed,
            EventType::PlanUpdated,
            EventType::ToolStarted,
            EventType::ToolProgressUpdated,
            EventType::ToolCompleted,
            EventType::ToolFailed,
            EventType::ArtifactCreated,
            EventType::ArtifactUpdated,
            EventType::AgentDelegated,
            EventType::AgentStatusChanged,
            EventType::ApprovalRequested,
            EventType::GitStatusChanged,
            EventType::GitOperationProgress,
            EventType::VoiceStateChanged,
            EventType::VisionAnalysisCompleted,
            EventType::FineTuneJobProgress,
            EventType::BackendDisconnected,
            EventType::BackendReconnected,
        ];
        for et in types {
            let json = serde_json::to_string(&et).unwrap();
            let decoded: EventType = serde_json::from_str(&json).unwrap();
            assert_eq!(et, decoded);
        }
    }

    #[test]
    fn message_role_round_trips() {
        let roles = vec![
            MessageRole::User,
            MessageRole::Fennec,
            MessageRole::OpenBot,
            MessageRole::Tool,
            MessageRole::System,
            MessageRole::Verification,
        ];
        for role in roles {
            let json = serde_json::to_string(&role).unwrap();
            let decoded: MessageRole = serde_json::from_str(&json).unwrap();
            assert_eq!(role, decoded);
        }
    }

    #[test]
    fn message_content_as_text() {
        let text = MessageContent::Text("hello".to_string());
        assert_eq!(text.as_text(), "hello");

        let code = MessageContent::Code(CodeBlock {
            language: "rust".to_string(),
            code: "fn main() {}".to_string(),
            filename: Some("main.rs".to_string()),
        });
        assert_eq!(code.as_text(), "fn main() {}");

        let reasoning = MessageContent::Reasoning(ReasoningSummary {
            summary: "thinking...".to_string(),
            plan: None,
            progress: None,
        });
        assert_eq!(reasoning.as_text(), "thinking...");

        let mixed = MessageContent::Mixed(vec![
            MessageContent::Text("part1".to_string()),
            MessageContent::Text("part2".to_string()),
        ]);
        assert_eq!(mixed.as_text(), "part1\npart2");
    }

    #[test]
    fn message_content_text_serializes_as_plain_string() {
        let text = MessageContent::Text("ready".to_string());
        let json = serde_json::to_value(&text).unwrap();
        assert_eq!(json, serde_json::Value::String("ready".into()));

        let decoded: MessageContent = serde_json::from_value(json).unwrap();
        assert_eq!(decoded.as_text(), "ready");
    }

    #[test]
    fn message_content_tagged_round_trips() {
        let code = MessageContent::Code(CodeBlock {
            language: "rust".to_string(),
            code: "fn main() {}".to_string(),
            filename: None,
        });
        let json = serde_json::to_value(&code).unwrap();
        assert!(json.is_object());

        let decoded: MessageContent = serde_json::from_value(json).unwrap();
        assert_eq!(decoded.as_text(), "fn main() {}");

        let legacy: MessageContent =
            serde_json::from_value(serde_json::json!({ "Text": "legacy" })).unwrap();
        assert_eq!(legacy.as_text(), "legacy");
    }

    #[test]
    fn message_status_round_trips() {
        let statuses = vec![
            MessageStatus::Pending,
            MessageStatus::Sent,
            MessageStatus::Delivered,
            MessageStatus::Failed,
            MessageStatus::Cancelled,
        ];
        for status in statuses {
            let json = serde_json::to_string(&status).unwrap();
            let decoded: MessageStatus = serde_json::from_str(&json).unwrap();
            assert_eq!(status, decoded);
        }
    }

    #[test]
    fn attachment_kind_round_trips() {
        let kinds = vec![
            AttachmentKind::Image,
            AttachmentKind::File,
            AttachmentKind::Screenshot,
            AttachmentKind::Log,
            AttachmentKind::Diff,
        ];
        for kind in kinds {
            let json = serde_json::to_string(&kind).unwrap();
            let decoded: AttachmentKind = serde_json::from_str(&json).unwrap();
            assert_eq!(kind, decoded);
        }
    }

    #[test]
    fn tool_event_kind_round_trips() {
        let kinds = vec![
            ToolEventKind::InspectRepository,
            ToolEventKind::ReadFile,
            ToolEventKind::SearchCode,
            ToolEventKind::CreateFile,
            ToolEventKind::EditFile,
            ToolEventKind::DeleteFile,
            ToolEventKind::ReviewDiff,
            ToolEventKind::RunCommand,
            ToolEventKind::RunTestSuite,
            ToolEventKind::BuildProject,
            ToolEventKind::LintProject,
            ToolEventKind::FormatProject,
            ToolEventKind::SearchDocumentation,
            ToolEventKind::OpenUrl,
            ToolEventKind::AnalyzeImage,
            ToolEventKind::GenerateArtifact,
            ToolEventKind::VerifyImplementation,
            ToolEventKind::GitFetch,
            ToolEventKind::GitPull,
            ToolEventKind::GitCommit,
            ToolEventKind::GitPush,
            ToolEventKind::PullRequestOperation,
            ToolEventKind::FineTuneModel,
            ToolEventKind::EvaluateFineTunedModel,
        ];
        for kind in kinds {
            let json = serde_json::to_string(&kind).unwrap();
            let decoded: ToolEventKind = serde_json::from_str(&json).unwrap();
            assert_eq!(kind, decoded);
        }
    }

    #[test]
    fn tool_event_status_round_trips() {
        let statuses = vec![
            ToolEventStatus::Running,
            ToolEventStatus::Complete,
            ToolEventStatus::Warning,
            ToolEventStatus::Failed,
            ToolEventStatus::Cancelled,
            ToolEventStatus::WaitingForApproval,
        ];
        for status in statuses {
            let json = serde_json::to_string(&status).unwrap();
            let decoded: ToolEventStatus = serde_json::from_str(&json).unwrap();
            assert_eq!(status, decoded);
        }
    }

    #[test]
    fn artifact_kind_round_trips() {
        let kinds = vec![
            ArtifactKind::Diff,
            ArtifactKind::Build,
            ArtifactKind::Test,
            ArtifactKind::Image,
            ArtifactKind::Summary,
            ArtifactKind::Report,
            ArtifactKind::Documentation,
        ];
        for kind in kinds {
            let json = serde_json::to_string(&kind).unwrap();
            let decoded: ArtifactKind = serde_json::from_str(&json).unwrap();
            assert_eq!(kind, decoded);
        }
    }

    #[test]
    fn artifact_status_round_trips() {
        let statuses = vec![
            ArtifactStatus::Added,
            ArtifactStatus::Modified,
            ArtifactStatus::Deleted,
            ArtifactStatus::Generated,
            ArtifactStatus::Reviewed,
            ArtifactStatus::Failed,
            ArtifactStatus::Pending,
        ];
        for status in statuses {
            let json = serde_json::to_string(&status).unwrap();
            let decoded: ArtifactStatus = serde_json::from_str(&json).unwrap();
            assert_eq!(status, decoded);
        }
    }
}
