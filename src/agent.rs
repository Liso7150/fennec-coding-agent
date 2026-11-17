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
    // Browser automation capabilities (OpenCode Browse integration)
    BrowserNavigate,
    BrowserClick,
    BrowserType,
    BrowserScreenshot,
    BrowserExtractText,
    BrowserExecuteScript,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Agent {
    pub identity: AgentIdentity,
    pub status: AgentStatus,
    pub capabilities: Vec<AgentCapability>,
    pub current_task: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_identity_round_trips_through_json() {
        let identities = vec![
            AgentIdentity::Fennec,
            AgentIdentity::Jev,
            AgentIdentity::OpenBot,
            AgentIdentity::Planner,
            AgentIdentity::RepositoryInspector,
            AgentIdentity::ImplementationWorker,
            AgentIdentity::VerificationWorker,
            AgentIdentity::ResearchWorker,
            AgentIdentity::VisionAnalyzer,
        ];
        for id in identities {
            let json = serde_json::to_string(&id).unwrap();
            let decoded: AgentIdentity = serde_json::from_str(&json).unwrap();
            assert_eq!(id, decoded);
        }
    }

    #[test]
    fn agent_status_round_trips_through_json() {
        let statuses = vec![
            AgentStatus::Available,
            AgentStatus::Busy,
            AgentStatus::Offline,
            AgentStatus::Error,
        ];
        for status in statuses {
            let json = serde_json::to_string(&status).unwrap();
            let decoded: AgentStatus = serde_json::from_str(&json).unwrap();
            assert_eq!(status, decoded);
        }
    }

    #[test]
    fn agent_serializes_with_all_fields() {
        let agent = Agent {
            identity: AgentIdentity::Fennec,
            status: AgentStatus::Available,
            capabilities: vec![AgentCapability::ReadFile, AgentCapability::EditFile],
            current_task: Some("task-123".to_string()),
            started_at: Some(Utc::now()),
        };
        let json = serde_json::to_string(&agent).unwrap();
        assert!(json.contains("\"Fennec\""));
        assert!(json.contains("\"Available\""));
        assert!(json.contains("ReadFile"));
        assert!(json.contains("task-123"));
    }

    #[test]
    fn agent_with_no_task_serializes_null() {
        let agent = Agent {
            identity: AgentIdentity::Jev,
            status: AgentStatus::Offline,
            capabilities: vec![],
            current_task: None,
            started_at: None,
        };
        let json = serde_json::to_string(&agent).unwrap();
        assert!(json.contains("\"current_task\":null"));
    }

    #[test]
    fn all_capabilities_serialize() {
        let caps = vec![
            AgentCapability::InspectRepository,
            AgentCapability::ReadFile,
            AgentCapability::EditFile,
            AgentCapability::CreateFile,
            AgentCapability::DeleteFile,
            AgentCapability::SearchCode,
            AgentCapability::GeneratePatch,
            AgentCapability::ApplyPatch,
            AgentCapability::ReviewDiff,
            AgentCapability::RunCommand,
            AgentCapability::RunTests,
            AgentCapability::BuildProject,
            AgentCapability::LintProject,
            AgentCapability::FormatProject,
            AgentCapability::GitFetch,
            AgentCapability::GitPull,
            AgentCapability::GitCommit,
            AgentCapability::GitPush,
            AgentCapability::CreatePullRequest,
            AgentCapability::AnalyzeImage,
            AgentCapability::GenerateArtifact,
            AgentCapability::VerifyImplementation,
            AgentCapability::DelegateTask,
        ];
        for cap in caps {
            let json = serde_json::to_string(&cap).unwrap();
            assert!(!json.is_empty());
        }
    }
}
