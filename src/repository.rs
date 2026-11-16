use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct RepositoryId(pub String);

impl RepositoryId {
    pub fn new() -> Self {
        Self(Uuid::new_v4().to_string())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RepositoryStatus {
    Clean,
    Dirty,
    Conflict,
    Detached,
    Uninitialized,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum GitSyncStatus {
    UpToDate,
    Ahead,
    Behind,
    Diverged,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum PullRequestStatus {
    None,
    Open,
    Merged,
    Closed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RepositoryCapability {
    Inspection,
    FileReading,
    FileEditing,
    PatchGeneration,
    DiffReview,
    GitStatus,
    GitFetch,
    GitPull,
    GitCommit,
    GitPush,
    PullRequestSupport,
    TerminalExecution,
    TestExecution,
    BuildExecution,
    Linting,
    Formatting,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Repository {
    pub id: RepositoryId,
    pub name: String,
    pub local_path: String,
    pub remote_url: Option<String>,
    pub current_branch: Option<String>,
    pub default_branch: Option<String>,
    pub status: RepositoryStatus,
    pub sync_status: GitSyncStatus,
    pub changed_files: usize,
    pub staged_files: usize,
    pub ahead_count: Option<usize>,
    pub behind_count: Option<usize>,
    pub last_fetch: Option<DateTime<Utc>>,
    pub last_opened: Option<DateTime<Utc>>,
    pub capabilities: Vec<RepositoryCapability>,
    pub github_auth_available: bool,
    pub pull_request_status: PullRequestStatus,
}

impl Repository {
    pub fn new(name: String, local_path: String) -> Self {
        Self {
            id: RepositoryId::new(),
            name,
            local_path,
            remote_url: None,
            current_branch: None,
            default_branch: None,
            status: RepositoryStatus::Uninitialized,
            sync_status: GitSyncStatus::Unknown,
            changed_files: 0,
            staged_files: 0,
            ahead_count: None,
            behind_count: None,
            last_fetch: None,
            last_opened: Some(Utc::now()),
            capabilities: Vec::new(),
            github_auth_available: false,
            pull_request_status: PullRequestStatus::None,
        }
    }
}
