use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AgentIdentity {
    Fennec,
    Jev,
    OpenBot,
    Planner,
    RepositoryInspector,
    ImplementationWorker,
    VerificationWorker,
    ResearchWorker,
    VisionAnalyzer,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentStatus {
    Available,
    Busy,
    Offline,
    Error,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum AgentCapability {
    InspectRepository,
    ReadFile,
    EditFile,
    CreateFile,
    DeleteFile,
    SearchCode,
    GeneratePatch,
    ApplyPatch,
    ReviewDiff,
    RunCommand,
    RunTests,
    BuildProject,
    LintProject,
    FormatProject,
    GitFetch,
    GitPull,
    GitCommit,
    GitPush,
    CreatePullRequest,
    AnalyzeImage,
    GenerateArtifact,
    VerifyImplementation,
    DelegateTask,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Agent {
    pub identity: AgentIdentity,
    pub status: AgentStatus,
    pub capabilities: Vec<AgentCapability>,
    pub current_task: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DelegationRequest {
    pub parent_task_id: String,
    pub target_agent: AgentIdentity,
    pub scope: String,
    pub instructions: String,
    pub context: serde_json::Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DelegationResult {
    pub delegation_id: String,
    pub parent_task_id: String,
    pub agent_identity: AgentIdentity,
    pub status: DelegationStatus,
    pub summary: Option<String>,
    pub artifacts: Vec<super::events::Artifact>,
    pub errors: Vec<String>,
    pub recommendations: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum DelegationStatus {
    Pending,
    InProgress,
    Complete,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ApprovalRequest {
    pub id: String,
    pub task_id: String,
    pub agent_identity: AgentIdentity,
    pub action: ApprovalAction,
    pub risk_level: RiskLevel,
    pub reason: String,
    pub affected_files: Vec<String>,
    pub command: Option<String>,
    pub choices: Vec<ApprovalChoice>,
    pub created_at: DateTime<Utc>,
    pub resolved: Option<ApprovalResolution>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum ApprovalAction {
    OverwriteFile,
    DeleteFile,
    RunDestructiveCommand,
    PullRemoteChanges,
    StashChanges,
    CommitCode,
    PushCode,
    CreatePullRequest,
    PublishRelease,
    ApplyBroadPatch,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RiskLevel {
    Low,
    Medium,
    High,
    Critical,
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

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AgentProgress {
    pub agent_identity: AgentIdentity,
    pub task_id: String,
    pub current_action: String,
    pub progress: f64,
    pub files_processed: usize,
    pub tools_executed: usize,
    pub elapsed_seconds: f64,
}
