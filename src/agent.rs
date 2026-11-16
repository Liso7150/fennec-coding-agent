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
