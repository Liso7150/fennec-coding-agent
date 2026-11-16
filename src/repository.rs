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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repository_id_new_generates_unique_ids() {
        let id1 = RepositoryId::new();
        let id2 = RepositoryId::new();
        assert_ne!(id1, id2);
    }

    #[test]
    fn repository_id_round_trips_through_json() {
        let id = RepositoryId("repo-abc-123".to_string());
        let json = serde_json::to_string(&id).unwrap();
        let decoded: RepositoryId = serde_json::from_str(&json).unwrap();
        assert_eq!(id, decoded);
    }

    #[test]
    fn repository_new_sets_defaults() {
        let repo = Repository::new("fennec".to_string(), "/home/user/fennec".to_string());
        assert_eq!(repo.name, "fennec");
        assert_eq!(repo.local_path, "/home/user/fennec");
        assert_eq!(repo.status, RepositoryStatus::Uninitialized);
        assert_eq!(repo.sync_status, GitSyncStatus::Unknown);
        assert_eq!(repo.pull_request_status, PullRequestStatus::None);
        assert!(!repo.github_auth_available);
        assert!(repo.remote_url.is_none());
        assert!(repo.current_branch.is_none());
        assert!(repo.capabilities.is_empty());
        assert!(repo.last_opened.is_some());
    }

    #[test]
    fn repository_status_round_trips() {
        let statuses = vec![
            RepositoryStatus::Clean,
            RepositoryStatus::Dirty,
            RepositoryStatus::Conflict,
            RepositoryStatus::Detached,
            RepositoryStatus::Uninitialized,
        ];
        for status in statuses {
            let json = serde_json::to_string(&status).unwrap();
            let decoded: RepositoryStatus = serde_json::from_str(&json).unwrap();
            assert_eq!(status, decoded);
        }
    }

    #[test]
    fn git_sync_status_round_trips() {
        let statuses = vec![
            GitSyncStatus::UpToDate,
            GitSyncStatus::Ahead,
            GitSyncStatus::Behind,
            GitSyncStatus::Diverged,
            GitSyncStatus::Unknown,
        ];
        for status in statuses {
            let json = serde_json::to_string(&status).unwrap();
            let decoded: GitSyncStatus = serde_json::from_str(&json).unwrap();
            assert_eq!(status, decoded);
        }
    }

    #[test]
    fn pull_request_status_round_trips() {
        let statuses = vec![
            PullRequestStatus::None,
            PullRequestStatus::Open,
            PullRequestStatus::Merged,
            PullRequestStatus::Closed,
        ];
        for status in statuses {
            let json = serde_json::to_string(&status).unwrap();
            let decoded: PullRequestStatus = serde_json::from_str(&json).unwrap();
            assert_eq!(status, decoded);
        }
    }

    #[test]
    fn repository_full_serialization_round_trip() {
        let mut repo = Repository::new("test-repo".to_string(), "/tmp/test".to_string());
        repo.remote_url = Some("https://github.com/test/repo.git".to_string());
        repo.current_branch = Some("main".to_string());
        repo.default_branch = Some("main".to_string());
        repo.status = RepositoryStatus::Clean;
        repo.sync_status = GitSyncStatus::UpToDate;
        repo.changed_files = 3;
        repo.staged_files = 1;
        repo.ahead_count = Some(2);
        repo.behind_count = None;
        repo.capabilities = vec![RepositoryCapability::GitStatus, RepositoryCapability::FileReading];
        repo.github_auth_available = true;
        repo.pull_request_status = PullRequestStatus::Open;

        let json = serde_json::to_string(&repo).unwrap();
        let decoded: Repository = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.name, "test-repo");
        assert_eq!(decoded.status, RepositoryStatus::Clean);
        assert_eq!(decoded.sync_status, GitSyncStatus::UpToDate);
        assert_eq!(decoded.changed_files, 3);
        assert_eq!(decoded.ahead_count, Some(2));
        assert!(decoded.github_auth_available);
        assert_eq!(decoded.pull_request_status, PullRequestStatus::Open);
    }
}
