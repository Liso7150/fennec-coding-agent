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

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GitRemote {
    pub name: String,
    pub url: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GitBranch {
    pub name: String,
    pub is_default: bool,
    pub is_current: bool,
    pub ahead: Option<usize>,
    pub behind: Option<usize>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GitCommit {
    pub hash: String,
    pub message: String,
    pub author: String,
    pub timestamp: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GitFileChange {
    pub path: String,
    pub status: FileChangeStatus,
    pub additions: Option<usize>,
    pub deletions: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum FileChangeStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
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

    pub fn can_perform(&self, capability: RepositoryCapability) -> bool {
        self.capabilities.contains(&capability)
    }

    pub fn is_clean(&self) -> bool {
        self.status == RepositoryStatus::Clean && self.changed_files == 0
    }

    pub fn has_conflicts(&self) -> bool {
        self.status == RepositoryStatus::Conflict
    }
}
